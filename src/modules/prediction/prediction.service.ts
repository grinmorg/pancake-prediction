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
  consecutiveLosses: number; // Добавленное поле для отслеживания последовательных проигрышей
  active: boolean; // Флаг активности стрима
  winCount: number; // Добавленное поле для отслеживания побед
  totalBets: number; // Общее количество ставок
  totalWins: number; // Общее количество побед
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
  private readonly BASE_LOSS_MULTIPLIER = 21n; // 2.1x базовый множитель
  private readonly BASE_BET_MULTIPLIER = 5n; // 1x - min bet usually 0.6$
  private readonly BET_SECONDS_BEFORE_END = 8;
  private readonly logger = new Logger(PredictionService.name);
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;
  private baseBetAmount: bigint;
  private betHistory: BetHistory[] = [];
  private activeStreams: BetStream[] = [];
  private readonly MAX_STREAMS = 2;
  private lastUsedStreamIndex = 0;

  private dailyPnL: number = 0;
  private dailyResetTimer: NodeJS.Timeout;
  private currentBnbPrice: number = 0;

  // Новые настройки для улучшения стратегии
  private readonly MAX_CONSECUTIVE_LOSSES = 10; // Максимальное количество проигрышей подряд перед остановкой
  private readonly MAX_BET_PERCENTAGE = 0.07; // Максимальный % от банкролла на одну ставку (7%)
  private readonly STREAM_COOLDOWN_ROUNDS = 5; // Количество раундов паузы после остановки стрима
  private streamCooldowns: Record<number, number> = {}; // Отслеживание паузы для стримов
  private maxBetAmount: bigint; // Максимальный размер ставки
  private totalBankroll: bigint; // Текущий размер банкролла

  constructor(
    private readonly config: ConfigService,
    private readonly telegramService: TelegramService,
  ) {}

  async onModuleInit() {
    await this.initializeProvider();
    await this.initializeContract();

    this.activeStreams = Array.from({ length: this.MAX_STREAMS }, (_, i) => ({
      id: i + 1,
      currentAmount: this.baseBetAmount,
      lossCount: 0,
      lastEpoch: null,
      positionHistory: [],
      consecutiveLosses: 0,
      active: true,
      winCount: 0,
      totalBets: 0,
      totalWins: 0,
    }));

    // Инициализация текущего банкролла
    this.totalBankroll = await this.provider.getBalance(this.wallet.address);
    // Установка максимального размера ставки на основе банкролла
    this.updateMaxBetAmount();

    this.listenToEvents();
    this.startBettingStrategy();

    this.startDailyReset();
    this.startBnbPriceUpdater();
    this.startBankrollMonitor();
  }

  // Новый метод для обновления максимального размера ставки
  private async updateMaxBetAmount() {
    this.totalBankroll = await this.provider.getBalance(this.wallet.address);
    this.maxBetAmount =
      (this.totalBankroll * BigInt(Math.floor(this.MAX_BET_PERCENTAGE * 100))) /
      100n;
    this.logger.log(
      `Updated max bet amount: ${ethers.formatEther(this.maxBetAmount)} BNB`,
    );
  }

  // Новый метод для мониторинга банкролла
  private startBankrollMonitor() {
    setInterval(async () => {
      await this.updateMaxBetAmount();

      const balanceBNB = ethers.formatEther(this.totalBankroll);
      const balanceUSD = parseFloat(balanceBNB) * this.currentBnbPrice;

      this.sendTelegramMessage(
        `💰 Bankroll Update\n` +
          `Balance: ${balanceBNB} BNB ($${balanceUSD.toFixed(2)})\n` +
          `Max bet: ${ethers.formatEther(this.maxBetAmount)} BNB`,
      );
    }, 3600_000); // Обновление каждый час
  }

  private async initializeProvider() {
    try {
      const privateKey = this.config.get<string>('WALLET_PRIVATE_KEY');
      if (!privateKey?.startsWith('0x')) {
        throw new Error('Invalid private key format. Must start with 0x');
      }

      this.provider = new ethers.JsonRpcProvider(
        this.config.get('BSC_RPC_URL') || 'https://bsc-dataseed.binance.org/',
        { name: 'binance', chainId: 56 },
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
    this.logger.log(
      `Min bet amount: ${ethers.formatEther(this.baseBetAmount)} BNB`,
    );

    // Инициализируем максимальную ставку
    this.totalBankroll = await this.provider.getBalance(this.wallet.address);
    this.maxBetAmount =
      (this.totalBankroll * BigInt(Math.floor(this.MAX_BET_PERCENTAGE * 100))) /
      100n;
    this.logger.log(
      `Max bet amount: ${ethers.formatEther(this.maxBetAmount)} BNB`,
    );
  }

  private listenToEvents() {
    this.contract.on('LockRound', async (epoch, price) => {
      const round = await this.getRoundData(epoch);
      const total = BigInt(round.totalAmount);
      const treasuryFee = (total * 300n) / 10000n;
      const prizePool = total - treasuryFee;
      const bullPayout =
        round.bullAmount > 0n ? prizePool / round.bullAmount : 0n;
      const bearPayout =
        round.bearAmount > 0n ? prizePool / round.bearAmount : 0n;

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

      // Уменьшаем cooldown для остановленных стримов
      Object.keys(this.streamCooldowns).forEach((streamId) => {
        if (this.streamCooldowns[streamId] > 0) {
          this.streamCooldowns[streamId]--;
          if (this.streamCooldowns[streamId] === 0) {
            const stream = this.activeStreams.find(
              (s) => s.id === parseInt(streamId),
            );
            if (stream) {
              stream.active = true;
              stream.currentAmount = this.baseBetAmount;
              stream.consecutiveLosses = 0;
              stream.lossCount = 0;
              this.sendTelegramMessage(
                `🔄 Stream #${streamId} reactivated after cooldown`,
              );
            }
          }
        }
      });
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
    }, 60_000);
    this.updateBnbPrice();
  }

  private startDailyReset(): void {
    const now = new Date();
    const nextReset = new Date(now);
    nextReset.setUTCHours(24, 0, 0, 0);

    const initialDelay = nextReset.getTime() - now.getTime();

    this.dailyResetTimer = setTimeout(() => {
      this.dailyPnL = 0;
      this.sendTelegramMessage('🔄 Daily PnL reset to $0.00');
      setInterval(() => {
        this.dailyPnL = 0;
        this.sendTelegramMessage('🔄 Daily PnL reset to $0.00');
      }, 86_400_000);
    }, initialDelay);
  }

  // Метод для расчета адаптивного множителя
  private calculateAdaptiveMultiplier(stream: BetStream): bigint {
    if (stream.totalBets < 10) {
      // Недостаточно данных, используем базовый множитель
      return this.BASE_LOSS_MULTIPLIER;
    }

    // Рассчитываем винрейт (0-100)
    const winRate = (stream.totalWins * 100) / stream.totalBets;

    // Адаптивная логика:
    // - Если винрейт высокий (>55%), можно использовать более агрессивный множитель
    // - Если винрейт низкий (<45%), используем более консервативный множитель
    // - В остальных случаях используем стандартный множитель

    if (winRate > 55) {
      return this.BASE_LOSS_MULTIPLIER + 2n; // 2.3x для высокого винрейта
    } else if (winRate < 45) {
      return this.BASE_LOSS_MULTIPLIER - 3n; // 1.8x для низкого винрейта
    } else {
      return this.BASE_LOSS_MULTIPLIER; // 2.1x стандартный
    }
  }

  private async handleRoundResult(epoch: number) {
    const round = await this.getRoundData(epoch);
    const betsForRound = this.betHistory.filter((b) => b.epoch === epoch);

    for (const bet of betsForRound) {
      const stream = this.activeStreams.find((s) => s.id === bet.streamId);
      if (!stream) continue;

      // Обновляем общую статистику ставок для стрима
      stream.totalBets++;

      const isWin = this.checkSingleBetResult(bet, round);
      const resultEmoji = isWin ? '✅' : '❌';

      // Calculate USD value of bet
      const betAmountUsd =
        parseFloat(ethers.formatEther(bet.amount)) * this.currentBnbPrice;

      if (isWin) {
        stream.totalWins++;
        stream.winCount++;
        stream.consecutiveLosses = 0;
        const reward = await this.calculateReward(bet);
        const usdReward = reward * this.currentBnbPrice;
        this.dailyPnL += usdReward;

        this.sendTelegramMessage(
          `📈 Daily PnL Update: $${this.dailyPnL.toFixed(2)}\n` +
            `📊 Current BNB Price: $${this.currentBnbPrice.toFixed(2)}`,
        );
      } else {
        stream.consecutiveLosses++;
        stream.winCount = 0;

        // Проверка на максимальное количество последовательных проигрышей
        if (stream.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES) {
          stream.active = false;
          this.streamCooldowns[stream.id] = this.STREAM_COOLDOWN_ROUNDS;
          this.sendTelegramMessage(
            `⚠️ Stream #${stream.id} deactivated due to ${stream.consecutiveLosses} consecutive losses.\n` +
              `Will be reactivated after ${this.STREAM_COOLDOWN_ROUNDS} rounds.`,
          );
        }

        // Decrement PnL when bet loses - subtract the bet amount
        this.dailyPnL -= betAmountUsd;

        this.sendTelegramMessage(
          `📉 Daily PnL Update: $${this.dailyPnL.toFixed(2)}\n` +
            `📊 Current BNB Price: $${this.currentBnbPrice.toFixed(2)}`,
        );
      }

      const message =
        `${resultEmoji} Stream #${stream.id} ${isWin ? 'WON' : 'LOST'} round #${epoch}\n` +
        `💰 Bet: ${ethers.formatEther(bet.amount)} BNB on ${bet.position}\n` +
        `📉 Loss Streak: ${stream.lossCount}/${stream.consecutiveLosses}\n` +
        `📊 Win Rate: ${((stream.totalWins / stream.totalBets) * 100).toFixed(1)}% (${stream.totalWins}/${stream.totalBets})`;

      this.sendTelegramMessage(message);

      if (isWin) {
        await this.claimSingleBet(bet);
        stream.currentAmount = this.baseBetAmount;
        stream.lossCount = 0;
      } else {
        stream.lossCount++;
        // Увеличиваем ставку только после 2 проигрышей подряд
        if (stream.lossCount >= 2) {
          // Используем адаптивный множитель вместо фиксированного
          const adaptiveMultiplier = this.calculateAdaptiveMultiplier(stream);
          stream.currentAmount =
            (stream.currentAmount * adaptiveMultiplier) / 10n;

          // Проверяем, не превышает ли новая ставка максимально допустимую
          if (stream.currentAmount > this.maxBetAmount) {
            stream.currentAmount = this.maxBetAmount;
            this.sendTelegramMessage(
              `⚠️ Stream #${stream.id} bet size capped at ${ethers.formatEther(this.maxBetAmount)} BNB (${this.MAX_BET_PERCENTAGE * 100}% of bankroll)`,
            );
          }

          this.sendTelegramMessage(
            `🔄 Stream #${stream.id} using multiplier: ${adaptiveMultiplier / 10n}.${adaptiveMultiplier % 10n}x\n` +
              `New bet size: ${ethers.formatEther(stream.currentAmount)} BNB`,
          );

          stream.lossCount = 0; // Сбрасываем счетчик после увеличения
        }
      }

      stream.positionHistory = [
        ...stream.positionHistory.slice(-4),
        bet.position,
      ];
    }

    const streamsStatus = this.activeStreams
      .map(
        (stream) =>
          `📊 Stream #${stream.id}: ${ethers.formatEther(stream.currentAmount)} BNB\n` +
          `📉 Losses: ${stream.lossCount}/${stream.consecutiveLosses}\n` +
          `🏆 Win Rate: ${((stream.totalWins / stream.totalBets) * 100).toFixed(1)}%\n` +
          `🚦 Status: ${stream.active ? 'Active' : 'Cooldown: ' + this.streamCooldowns[stream.id] + ' rounds'}`,
      )
      .join('\n\n');

    this.sendTelegramMessage(
      `🔄 Streams status after round #${epoch}:\n\n${streamsStatus}`,
    );
  }

  private async calculateReward(bet: BetHistory): Promise<number> {
    try {
      const round = await this.getRoundData(bet.epoch);

      // If the round wasn't won by bet's position, return 0
      if (
        (bet.position === 'Bull' && round.closePrice <= round.lockPrice) ||
        (bet.position === 'Bear' && round.closePrice >= round.lockPrice)
      ) {
        return 0;
      }

      // Get the actual amounts from the contract
      const totalAmount = parseFloat(ethers.formatEther(round.totalAmount));
      const positionAmount = parseFloat(
        ethers.formatEther(
          bet.position === 'Bull' ? round.bullAmount : round.bearAmount,
        ),
      );

      // Calculate treasury fee (3%)
      const treasuryFee = totalAmount * 0.03;
      const rewardPool = totalAmount - treasuryFee;

      // Calculate the payout ratio for this position
      const payoutRatio = rewardPool / positionAmount;

      // Calculate the actual reward for this bet
      const betAmount = parseFloat(ethers.formatEther(bet.amount));
      const reward = betAmount * payoutRatio;

      return reward;
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
      const totalReward = await this.calculateReward(bet);

      // Вычисляем чистую прибыль
      const betAmountBnb = parseFloat(ethers.formatEther(bet.amount));
      const netProfitBnb = totalReward - betAmountBnb;
      const netProfitUsd = netProfitBnb * this.currentBnbPrice;

      // Добавляем к PnL только чистую прибыль
      this.dailyPnL += netProfitUsd;

      this.sendTelegramMessage(
        `🏆 Claimed reward for round ${bet.epoch}\n` +
          `💰 Total Reward: $${(totalReward * this.currentBnbPrice).toFixed(2)}\n` +
          `💹 Net Profit: $${netProfitUsd.toFixed(2)} (${netProfitBnb.toFixed(6)} BNB)\n` +
          `📈 Total Daily PnL: $${this.dailyPnL.toFixed(2)}\n` +
          `Tx: ${tx.hash}`,
      );

      // Обновляем максимальную ставку после выигрыша
      await this.updateMaxBetAmount();
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
      // Дополнительная проверка на активность стрима
      const isAvailable =
        stream.active &&
        stream.lastEpoch !== epoch &&
        !this.betHistory.some(
          (b) => b.epoch === epoch && b.streamId === stream.id,
        );
      return isAvailable;
    });

    if (availableStreams.length === 0) return null;

    const selectedIndex = this.lastUsedStreamIndex % availableStreams.length;
    this.lastUsedStreamIndex++;
    return availableStreams[selectedIndex];
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
    return (
      now >= round.lockTimestamp - this.BET_SECONDS_BEFORE_END &&
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
