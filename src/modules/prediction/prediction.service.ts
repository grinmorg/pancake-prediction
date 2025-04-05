import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { TelegramService } from '../telegram-bot/telegram.service';
import { predictionAbi } from './pancake-prediction-abi';

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
  private readonly LOSS_MULTIPLIER = 2n;
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

    this.baseBetAmount = await this.contract.minBetAmount();
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
        await this.checkAndClaimWinnings();
      }
    });

    this.provider.on('error', (error) => {
      this.logger.error('Provider error:', error);
      this.sendTelegramMessage(`⚠️ Provider error: ${error.message}`);
    });
  }

  private async handleRoundResult(epoch: number) {
    const round = await this.getRoundData(epoch);
    const betsForRound = this.betHistory.filter((b) => b.epoch === epoch);

    // Отправляем результаты для каждой ставки
    betsForRound.forEach((bet) => {
      const stream = this.activeStreams.find((s) => s.id === bet.streamId);
      if (!stream) return;

      const isWin = this.checkSingleBetResult(bet, round);
      const resultEmoji = isWin ? '✅' : '❌';
      const resultText = isWin ? 'WON' : 'LOST';

      const message =
        `${resultEmoji} Stream #${stream.id} ${resultText} round #${epoch}\n` +
        `💰 Bet: ${ethers.formatEther(bet.amount)} BNB on ${bet.position}\n` +
        `🔒 Lock: ${ethers.formatUnits(round.lockPrice, 8)}\n` +
        `🔓 Close: ${ethers.formatUnits(round.closePrice, 8)}\n` +
        `📉 Loss Streak: ${stream.lossCount}`;

      this.sendTelegramMessage(message);
    });

    // Обновляем состояния потоков
    betsForRound.forEach((bet) => {
      const stream = this.activeStreams.find((s) => s.id === bet.streamId);
      if (!stream) return;

      const isWin = this.checkSingleBetResult(bet, round);

      if (isWin) {
        stream.currentAmount = this.baseBetAmount;
        stream.lossCount = 0;
      } else {
        stream.currentAmount = stream.currentAmount * this.LOSS_MULTIPLIER;
        stream.lossCount++;
      }

      // Обновляем историю позиций
      stream.positionHistory.push(bet.position);
      if (stream.positionHistory.length > 5) {
        stream.positionHistory.shift();
      }
    });

    // Отправляем обновленные ставки потоков
    const streamsInfo = this.activeStreams
      .map(
        (stream) =>
          `📊 Stream #${stream.id}: ${ethers.formatEther(stream.currentAmount)} BNB\n` +
          `📉 Losses: ${stream.lossCount}`,
      )
      .join('\n\n');

    this.sendTelegramMessage(
      `🔄 Updated streams after round #${epoch}:\n\n${streamsInfo}`,
    );

    await this.checkAndClaimWinnings();
  }

  private async checkAndClaimWinnings() {
    if (this.betHistory.length < this.WIN_STREAK_TO_CLAIM) return;

    // Находим последние 3 не заклеймленные ставки
    const unclaimedBets = this.betHistory.filter((b) => !b.claimed);
    this.sendTelegramMessage(
      `⏳ Non-claimed rounds count: ${unclaimedBets.length}, waiting ${this.WIN_STREAK_TO_CLAIM} streak.`,
    );

    if (unclaimedBets.length < this.WIN_STREAK_TO_CLAIM) return;

    // Берем последние 3 ставки
    const lastThreeBets = unclaimedBets.slice(-this.WIN_STREAK_TO_CLAIM);

    // Проверяем, что все 3 выиграли
    const rounds = await Promise.all(
      lastThreeBets.map((bet) => this.getRoundData(bet.epoch)),
    );

    const allWon = lastThreeBets.every((bet, index) =>
      this.checkSingleBetResult(bet, rounds[index]),
    );

    if (allWon) {
      const epochsToClaim = lastThreeBets.map((bet) => bet.epoch);
      try {
        const tx = await this.contract.claim(epochsToClaim);
        await tx.wait();

        // Помечаем ставки как заклеймленные
        lastThreeBets.forEach((bet) => {
          const betToUpdate = this.betHistory.find(
            (b) => b.epoch === bet.epoch && b.position === bet.position,
          );
          if (betToUpdate) betToUpdate.claimed = true;
        });

        this.sendTelegramMessage(
          `🏆 Claimed rewards for rounds: ${epochsToClaim.join(', ')} | Tx: ${tx.hash}`,
        );
      } catch (error) {
        this.sendTelegramMessage(
          `⚠️ Failed to claim rewards: ${error.reason || error.message}`,
        );
      }
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
    const availableStreams = this.activeStreams.filter(
      (stream) =>
        stream.lastEpoch !== epoch &&
        !this.betHistory.some(
          (b) => b.epoch === epoch && b.streamId === stream.id,
        ),
    );

    if (availableStreams.length === 0) return null;

    // Выбираем следующий поток в доступных
    const nextIndex =
      (this.activeStreams.findIndex((s) => s.id === availableStreams[0].id) +
        1) %
      this.activeStreams.length;
    return (
      availableStreams.find((s) => s.id === this.activeStreams[nextIndex].id) ||
      availableStreams[0]
    );
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

    // Делаем ставку за 15 сек до конца раунда
    return (
      now >= round.lockTimestamp - 15 &&
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
    const position = this.calculateBetPosition(round, stream);

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

  private calculateBetPosition(
    round: Round,
    stream: BetStream,
  ): 'Bull' | 'Bear' {
    // Анализ истории позиций для выбора направления
    const lastPosition =
      stream.positionHistory[stream.positionHistory.length - 1];
    const secondLast =
      stream.positionHistory[stream.positionHistory.length - 2];

    // Если два последних проигрыша на одном направлении - меняем
    if (lastPosition && lastPosition === secondLast) {
      return lastPosition === 'Bull' ? 'Bear' : 'Bull';
    }

    // Базовая логика из предыдущей реализации
    const treasuryFee = (round.totalAmount * 300n) / 10000n;
    const prizePool = round.totalAmount - treasuryFee;

    const bullPayout =
      round.bullAmount > 0n ? prizePool / round.bullAmount : 0n;
    const bearPayout =
      round.bearAmount > 0n ? prizePool / round.bearAmount : 0n;

    return bullPayout > bearPayout ? 'Bull' : 'Bear';
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
