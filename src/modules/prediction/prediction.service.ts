import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { TelegramService } from '../telegram-bot/telegram.service';
import { predictionAbi } from './pancake-prediction-abi';
import axios from 'axios';

const CONTRACT_ADDRESS = '0x18b2a687610328590bc8f2e5fedde3b582a49cda';

interface Round {
  epoch: number;
  startTimestamp: number;
  lockTimestamp: number;
  closeTimestamp: number;
  lockPrice: bigint;
  closePrice: bigint;
  totalAmount: bigint;
  bullAmount: bigint;
  bearAmount: bigint;
  oracleCalled: boolean;
  canBet: boolean;
}

interface BetStream {
  id: number;
  currentAmount: bigint;
  lossCount: number;
  lastEpoch: number | null;
  positionHistory: Array<'Bull' | 'Bear'>;
}

interface BetHistory {
  epoch: number;
  position: 'Bull' | 'Bear';
  amount: bigint;
  claimed: boolean;
  streamId: number;
}

@Injectable()
export class PredictionService implements OnModuleInit {
  private readonly LOSS_MULTIPLIER = 21n; // 2.1x
  private readonly BASE_BET_MULTIPLIER = 1n; // 1x - min bet usually 0.6$
  private readonly logger = new Logger(PredictionService.name);
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;
  private currentBetAmount: bigint;
  private baseBetAmount: bigint;
  private lastBetPosition: 'Bull' | 'Bear' | null = null;
  private lastBetEpoch: number | null = null;
  private betHistory: BetHistory[] = [];
  private readonly WIN_STREAK_TO_CLAIM = 3;
  private activeStreams: BetStream[] = [];
  private readonly MAX_STREAMS = 2;
  private lastUsedStreamIndex = 0;

  private dailyPnL: number = 0; // В USD
  private dailyResetTimer: NodeJS.Timeout;
  private currentBnbPrice: number = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly telegramService: TelegramService,
  ) {}

  async onModuleInit() {
    await this.initializeProvider();
    await this.initializeContract();

    // Initialize the bet streams
    this.activeStreams = Array.from({ length: this.MAX_STREAMS }, (_, i) => ({
      id: i + 1,
      currentAmount: this.baseBetAmount,
      lossCount: 0,
      lastEpoch: null,
      positionHistory: [],
    }));

    this.listenToEvents();
    this.startBettingStrategy();

    this.startDailyReset();
    this.startBnbPriceUpdater();
  }

  private async initializeProvider() {
    try {
      const privateKey = this.config.get<string>('WALLET_PRIVATE_KEY');
      if (!privateKey?.startsWith('0x')) {
        throw new Error('Invalid private key format. Must start with 0x');
      }

      this.provider = new ethers.JsonRpcProvider(
        this.config.get('BSC_RPC_URL') || 'https://bsc-dataseed.binance.org/',
        {
          name: 'binance',
          chainId: 56,
        },
      );

      this.wallet = new ethers.Wallet(privateKey, this.provider);

      this.logger.log(`Connected to BSC network`);
      this.logger.log(`Operator address: ${this.wallet.address}`);
      this.logger.log(
        `Balance: ${ethers.formatEther(await this.provider.getBalance(this.wallet.address))} BNB`,
      );
    } catch (error) {
      this.logger.error('Provider initialization failed', error.stack);
      throw error;
    }
  }

  private async initializeContract() {
    this.contract = new ethers.Contract(
      CONTRACT_ADDRESS,
      predictionAbi,
      this.wallet,
    );

    this.baseBetAmount =
      (await this.contract.minBetAmount()) * this.BASE_BET_MULTIPLIER;
    this.currentBetAmount = this.baseBetAmount;
    this.logger.log(
      `Min bet amount: ${ethers.formatEther(this.baseBetAmount)} BNB`,
    );
  }

  private listenToEvents() {
    this.contract.on('LockRound', async (epoch, price) => {
      const round = await this.getRoundData(epoch);

      // Добавляем информацию о выплатах
      const total = BigInt(round.totalAmount);

      const treasuryFee = (total * BigInt(300n)) / 10000n;
      const prizePool = total - treasuryFee;
      const bullPayout =
        round.bullAmount > 0n ? prizePool / BigInt(round.bullAmount) : 0n;
      const bearPayout =
        round.bearAmount > 0n ? prizePool / BigInt(round.bearAmount) : 0n;

      const message =
        `🔒 Round #${epoch} locked at ${ethers.formatEther(price)}\n` +
        `📊 Total bets: ${ethers.formatEther(total)} BNB\n` +
        `🐂 Bull: ${ethers.formatEther(round.bullAmount)} BNB | Payout: x${bullPayout}\n` +
        `🐻 Bear: ${ethers.formatEther(round.bearAmount)} BNB | Payout: x${bearPayout}\n` +
        `🏦 Treasury fee: ${ethers.formatEther(treasuryFee)} BNB`;

      this.telegramService.sendMessage(
        this.config.get('RECEIVER_TELEGRAM_ID'),
        message,
      );
    });

    this.contract.on('EndRound', async (epoch) => {
      const betsForRound = this.betHistory.filter(
        (b) => b.epoch === Number(epoch),
      );
      if (betsForRound.length > 0) {
        await this.handleRoundResult(Number(epoch));
      }
    });

    this.provider.on('error', (error) => {
      this.logger.error('Provider error:', error);
      this.sendTelegramMessage(`⚠️ Provider error: ${error.message}`);
    });
  }

  private async updateBnbPrice(): Promise<void> {
    try {
      const response = await axios.get(
        'https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT',
      );
      this.currentBnbPrice = parseFloat(response.data.price);
    } catch (error) {
      this.logger.error('Failed to update BNB price', error);
    }
  }

  private startBnbPriceUpdater(): void {
    setInterval(async () => {
      await this.updateBnbPrice();
    }, 60_000); // Обновление курса каждую минуту
    this.updateBnbPrice(); // Первоначальное обновление
  }

  private startDailyReset(): void {
    const now = new Date();
    const nextReset = new Date(now);
    nextReset.setUTCHours(24, 0, 0, 0); // Сброс в 00:00 UTC

    const initialDelay = nextReset.getTime() - now.getTime();

    this.dailyResetTimer = setTimeout(() => {
      this.dailyPnL = 0;
      this.sendTelegramMessage('🔄 Daily PnL reset to $0.00');
      // Повторяем каждый день
      setInterval(() => {
        this.dailyPnL = 0;
        this.sendTelegramMessage('🔄 Daily PnL reset to $0.00');
      }, 86_400_000);
    }, initialDelay);
  }

  private async handleRoundResult(epoch: number) {
    const round = await this.getRoundData(epoch);
    const betsForRound = this.betHistory.filter((b) => b.epoch === epoch);

    for (const bet of betsForRound) {
      const stream = this.activeStreams.find((s) => s.id === bet.streamId);
      if (!stream) continue;

      const isWin = this.checkSingleBetResult(bet, round);
      const resultEmoji = isWin ? '✅' : '❌';

      if (isWin) {
        const reward = await this.calculateReward(bet);
        const usdReward = reward * this.currentBnbPrice;
        this.dailyPnL += usdReward;

        this.sendTelegramMessage(
          `📈 Daily PnL Update: $${this.dailyPnL.toFixed(2)}\n` +
            `📊 Current BNB Price: $${this.currentBnbPrice.toFixed(2)}`,
        );
      }

      const message =
        `${resultEmoji} Stream #${stream.id} ${isWin ? 'WON' : 'LOST'} round #${epoch}\n` +
        `💰 Bet: ${ethers.formatEther(bet.amount)} BNB on ${bet.position}\n` +
        `📉 Loss Streak: ${stream.lossCount}`;

      this.sendTelegramMessage(message);

      // Обновление статуса ставки и потока
      if (isWin) {
        await this.claimSingleBet(bet);
        stream.currentAmount = this.baseBetAmount;
        stream.lossCount = 0;
      } else {
        stream.currentAmount =
          (stream.currentAmount * this.LOSS_MULTIPLIER) / 10n;
        stream.lossCount++;
      }

      // Обновление истории позиций
      stream.positionHistory = [
        ...stream.positionHistory.slice(-4),
        bet.position,
      ];
    }

    // Отправка обновленного статуса потоков
    const streamsStatus = this.activeStreams
      .map(
        (stream) =>
          `📊 Stream #${stream.id}: ${ethers.formatEther(stream.currentAmount)} BNB\n` +
          `📉 Losses: ${stream.lossCount}`,
      )
      .join('\n\n');

    this.sendTelegramMessage(
      `🔄 Streams status after round #${epoch}:\n\n${streamsStatus}`,
    );
  }

  private async calculateReward(bet: BetHistory): Promise<number> {
    try {
      const round = await this.getRoundData(bet.epoch);
      const totalAmount = parseFloat(ethers.formatEther(round.totalAmount));
      const positionAmount = parseFloat(
        ethers.formatEther(
          bet.position === 'Bull' ? round.bullAmount : round.bearAmount,
        ),
      );

      const treasuryFee = totalAmount * 0.03; // 3% fee
      const rewardPool = totalAmount - treasuryFee;
      const payout = rewardPool / positionAmount;

      return parseFloat(ethers.formatEther(bet.amount)) * payout;
    } catch (error) {
      this.logger.error('Reward calculation failed', error);
      return 0;
    }
  }

  private async claimSingleBet(bet: BetHistory) {
    if (bet.claimed) return;

    try {
      const tx = await this.contract.claim([bet.epoch]);
      await tx.wait();

      bet.claimed = true;
      const reward = await this.calculateReward(bet);
      const usdReward = reward * this.currentBnbPrice;
      this.dailyPnL += usdReward;

      this.sendTelegramMessage(
        `🏆 Claimed reward for round ${bet.epoch}\n` +
          `💰 Reward: $${usdReward.toFixed(2)}\n` +
          `📈 Total Daily PnL: $${this.dailyPnL.toFixed(2)}\n` +
          `Tx: ${tx.hash}`,
      );
    } catch (error) {
      this.sendTelegramMessage(
        `⚠️ Failed to claim round ${bet.epoch}: ${error.message}`,
      );
    }
  }

  private checkSingleBetResult(bet: BetHistory, round: Round): boolean {
    if (!round.oracleCalled) return false;

    return (
      (bet.position === 'Bull' && round.closePrice > round.lockPrice) ||
      (bet.position === 'Bear' && round.closePrice < round.lockPrice)
    );
  }

  private async startBettingStrategy() {
    setInterval(async () => {
      try {
        const currentEpoch = Number(await this.contract.currentEpoch());
        const nextEpoch = currentEpoch + 1;

        const currentRound = await this.getRoundData(currentEpoch);
        const nextRound = await this.getRoundData(nextEpoch);

        const bettingRound = this.isRoundBettable(nextRound)
          ? nextRound
          : currentRound;

        if (this.isBettable(bettingRound)) {
          // Выбираем поток для ставки
          const stream = this.selectStreamForBet(bettingRound.epoch);
          if (stream) {
            await this.placeBet(bettingRound.epoch, stream);
          }
        }
      } catch (error) {
        this.sendTelegramMessage(
          `❌ Strategy error: ${error.reason || error.message}`,
        );
      }
    }, 1_000);
  }

  private selectStreamForBet(epoch: number): BetStream | null {
    const availableStreams = this.activeStreams.filter((stream) => {
      const isAvailable =
        stream.lastEpoch !== epoch &&
        !this.betHistory.some(
          (b) => b.epoch === epoch && b.streamId === stream.id,
        );

      this.logger.debug(`Stream #${stream.id} available: ${isAvailable}`);
      return isAvailable;
    });

    if (availableStreams.length === 0) {
      this.logger.debug('No available streams');
      return null;
    }

    // Чередование потоков по модулю
    const selectedIndex = this.lastUsedStreamIndex % availableStreams.length;
    this.lastUsedStreamIndex++;
    const selectedStream = availableStreams[selectedIndex];

    this.logger.debug(
      `Selected stream #${selectedStream.id} for epoch ${epoch}`,
    );
    return selectedStream;
  }

  private isRoundBettable(round: Round): boolean {
    const now = Math.floor(Date.now() / 1000);
    return (
      round.startTimestamp <= now &&
      now < round.lockTimestamp &&
      !round.oracleCalled
    );
  }

  private isBettable(round: Round): boolean {
    const now = Math.floor(Date.now() / 1000);

    // Делаем ставку за 11 сек до конца раунда
    return (
      now >= round.lockTimestamp - 11 &&
      now < round.lockTimestamp &&
      this.isRoundBettable(round) &&
      !this.hasExistingBet(round.epoch)
    );
  }

  private hasExistingBet(epoch: number): boolean {
    return this.betHistory.some((b) => b.epoch === epoch && !b.claimed);
  }

  private async getRoundData(epoch: number): Promise<Round> {
    const roundData = await this.contract.rounds(epoch);
    const now = Math.floor(Date.now() / 1000);

    return {
      epoch: Number(roundData.epoch),
      startTimestamp: Number(roundData.startTimestamp),
      lockTimestamp: Number(roundData.lockTimestamp),
      closeTimestamp: Number(roundData.closeTimestamp),
      lockPrice: BigInt(roundData.lockPrice),
      closePrice: BigInt(roundData.closePrice),
      totalAmount: BigInt(roundData.totalAmount),
      bullAmount: BigInt(roundData.bullAmount),
      bearAmount: BigInt(roundData.bearAmount),
      oracleCalled: roundData.oracleCalled,
      canBet: now < Number(roundData.lockTimestamp) && !roundData.oracleCalled,
    };
  }

  private async placeBet(epoch: number, stream: BetStream) {
    const round = await this.getRoundData(epoch);
    const position = this.calculateBetPosition(round);

    if (await this.hasSufficientBalance(stream.currentAmount)) {
      try {
        const method = position === 'Bull' ? 'betBull' : 'betBear';
        const tx = await this.contract[method](epoch, {
          value: stream.currentAmount,
        });

        this.betHistory.push({
          epoch,
          position,
          amount: stream.currentAmount,
          claimed: false,
          streamId: stream.id,
        });

        stream.lastEpoch = epoch;

        await tx.wait(1);
        this.sendTelegramMessage(
          `🎲 Stream #${stream.id} bet ${ethers.formatEther(stream.currentAmount)} BNB on ${position} (#${epoch}) | Tx: ${tx.hash}`,
        );
      } catch (error) {
        this.sendTelegramMessage(
          `⚠️ Stream #${stream.id} bet error: ${error.reason || error.message}`,
        );
      }
    }
  }

  private calculateBetPosition(round: Round): 'Bull' | 'Bear' {
    // Выбираем направление с меньшим объемом ставок для лучшего коэффициента
    return round.bullAmount < round.bearAmount ? 'Bull' : 'Bear';
  }

  private async hasSufficientBalance(betAmount: bigint): Promise<boolean> {
    const balance = await this.provider.getBalance(this.wallet.address);

    if (balance < betAmount) {
      this.sendTelegramMessage(
        `⚠️ Insufficient balance for bet: ${ethers.formatEther(betAmount)} BNB`,
      );
      return false;
    }
    return true;
  }

  private sendTelegramMessage(message: string) {
    this.telegramService.sendMessage(
      this.config.get('RECEIVER_TELEGRAM_ID'),
      message,
    );
  }
}
