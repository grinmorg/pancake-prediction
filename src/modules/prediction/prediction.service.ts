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
  consecutiveLosses: number;
  maxConsecutiveLosses: number; // Максимальный лузстрик за всё время
  dailyMaxConsecutiveLosses: number; // Максимальный лузстрик за текущий день
  active: boolean;
  winCount: number;
  totalBets: number;
  totalWins: number;
  recoveryMode: boolean; // Режим восстановления после серии проигрышей
}

interface BetHistory {
  epoch: number;
  position: 'Bull' | 'Bear';
  amount: bigint;
  claimed: boolean;
  streamId: number;
}

// Конфигурация стратегии
enum StrategyType {
  FIXED_PERCENTAGE = 'fixed_percentage',
  MODIFIED_MARTINGALE = 'modified_martingale',
}

@Injectable()
export class PredictionService implements OnModuleInit {
  // Конфигурация стратегии
  private readonly STRATEGY_TYPE: StrategyType =
    StrategyType.MODIFIED_MARTINGALE; // Выбор стратегии
  private readonly FLAT_BET_COUNT = 3; // Количество ставок одинакового размера перед увеличением
  private readonly MARTINGALE_MULTIPLIER = 21n; // Множитель для мартингейла (2.1x)
  private readonly FIXED_PERCENTAGE = 3; // Процент от баланса для фиксированной стратегии
  private readonly MAX_RISK_PERCENTAGE = 40; // Максимальный процент от баланса на одну ставку для ограничения риска

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

  private initialBankroll: bigint; // Переименуем totalBankroll в currentBankroll для ясности
  private dailyResetTimer: NodeJS.Timeout;
  private currentBnbPrice: number = 0;

  // Настройки управления рисками
  private readonly MAX_CONSECUTIVE_LOSSES = 12; // Максимальное количество проигрышей подряд перед остановкой
  private readonly STREAM_COOLDOWN_ROUNDS = 5; // Количество раундов паузы после остановки стрима
  private streamCooldowns: Record<number, number> = {}; // Отслеживание паузы для стримов
  private maxBetAmount: bigint; // Максимальный размер ставки
  private totalBankroll: bigint; // Текущий размер банкролла
  private lastDailyReset: Date = new Date(); // Дата последнего сброса дневной статистики

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
      maxConsecutiveLosses: 0,
      dailyMaxConsecutiveLosses: 0,
      active: true,
      winCount: 0,
      totalBets: 0,
      totalWins: 0,
      recoveryMode: false,
    }));

    // Инициализация текущего банкролла
    this.totalBankroll = await this.provider.getBalance(this.wallet.address);
    this.initialBankroll = this.totalBankroll; // Инициализация начального банкролла

    // Установка максимального размера ставки на основе банкролла
    this.updateMaxBetAmount();

    this.listenToEvents();
    this.startBettingStrategy();

    this.startDailyReset();
    this.startBnbPriceUpdater();
    this.startBankrollMonitor();

    // Отправляем информацию о запуске и текущей стратегии
    this.sendTelegramMessage(
      `🤖 Prediction Bot Started\n` +
        `💰 Initial Balance: ${ethers.formatEther(this.totalBankroll)} BNB\n` +
        `📊 Strategy: ${
          this.STRATEGY_TYPE === StrategyType.FIXED_PERCENTAGE
            ? `Fixed ${this.FIXED_PERCENTAGE}% of balance`
            : `Modified Martingale (${this.FLAT_BET_COUNT} flat bets, then ${this.MARTINGALE_MULTIPLIER / 10n}.${this.MARTINGALE_MULTIPLIER % 10n}x)`
        }\n` +
        `⚠️ Max risk per bet: ${this.MAX_RISK_PERCENTAGE}% of balance`,
    );
  }

  // Метод для обновления максимального размера ставки
  private async updateMaxBetAmount() {
    this.totalBankroll = await this.provider.getBalance(this.wallet.address);
    this.maxBetAmount =
      (this.totalBankroll *
        BigInt(Math.floor(this.MAX_RISK_PERCENTAGE * 100))) /
      10000n;
    this.logger.log(
      `Updated max bet amount: ${ethers.formatEther(this.maxBetAmount)} BNB`,
    );
  }

  // Метод для мониторинга банкролла
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
      (this.totalBankroll *
        BigInt(Math.floor(this.MAX_RISK_PERCENTAGE * 100))) /
      10000n;
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
              stream.currentAmount = this.calculateBaseBetAmount();
              stream.consecutiveLosses = 0;
              stream.lossCount = 0;
              stream.recoveryMode = false;
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
      this.resetDailyStats();
      setInterval(() => {
        this.resetDailyStats();
      }, 86_400_000);
    }, initialDelay);
  }

  private resetDailyStats(): void {
    this.lastDailyReset = new Date();

    // Сбрасываем дневную статистику лузстриков
    this.activeStreams.forEach((stream) => {
      stream.dailyMaxConsecutiveLosses = 0;
    });

    this.sendTelegramMessage('🔄 Daily stats reset');
  }

  // Новый метод для расчета базовой ставки в зависимости от стратегии
  private calculateBaseBetAmount(): bigint {
    if (this.STRATEGY_TYPE === StrategyType.FIXED_PERCENTAGE) {
      // Для стратегии с фиксированным процентом, используем процент от баланса
      return (
        (this.totalBankroll * BigInt(this.FIXED_PERCENTAGE * 100)) / 10000n
      );
    } else {
      // Для модифицированной мартингейл стратегии используем базовую ставку
      return this.baseBetAmount;
    }
  }

  // Метод для расчета следующей ставки в зависимости от стратегии
  private calculateNextBetAmount(stream: BetStream): bigint {
    const baseAmount = this.calculateBaseBetAmount();

    if (this.STRATEGY_TYPE === StrategyType.FIXED_PERCENTAGE) {
      return baseAmount;
    }

    if (stream.lossCount >= this.FLAT_BET_COUNT) {
      const lossStreak = stream.lossCount - this.FLAT_BET_COUNT;
      let calculatedAmount = baseAmount;

      // Постепенное умножение с проверкой на каждом шаге
      for (let i = 0; i <= lossStreak; i++) {
        calculatedAmount =
          (calculatedAmount * this.MARTINGALE_MULTIPLIER) / 10n;

        // Проверка максимальной ставки
        if (calculatedAmount > this.maxBetAmount) {
          return this.maxBetAmount;
        }

        // Проверка минимального баланса
        if (calculatedAmount > this.totalBankroll / 10n) {
          // Не более 10% баланса
          this.sendTelegramMessage(
            `⚠️ Stream #${stream.id} reached bankroll protection limit!`,
          );
          return this.maxBetAmount;
        }
      }

      return calculatedAmount;
    }

    return baseAmount;
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

      if (isWin) {
        stream.totalWins++;
        stream.winCount++;
        stream.consecutiveLosses = 0;
        // Выходим из режима восстановления после выигрыша
        stream.recoveryMode = false;
      } else {
        stream.consecutiveLosses++;
        stream.winCount = 0;

        // Обновляем статистику максимальных лузстриков
        if (stream.consecutiveLosses > stream.maxConsecutiveLosses) {
          stream.maxConsecutiveLosses = stream.consecutiveLosses;
        }

        if (stream.consecutiveLosses > stream.dailyMaxConsecutiveLosses) {
          stream.dailyMaxConsecutiveLosses = stream.consecutiveLosses;
        }

        // Проверка на максимальное количество последовательных проигрышей
        if (stream.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES) {
          stream.active = false;
          stream.recoveryMode = true;
          this.streamCooldowns[stream.id] = this.STREAM_COOLDOWN_ROUNDS;
          this.sendTelegramMessage(
            `⚠️ Stream #${stream.id} deactivated due to ${stream.consecutiveLosses} consecutive losses.\n` +
              `Will be reactivated after ${this.STREAM_COOLDOWN_ROUNDS} rounds in recovery mode.`,
          );
        }
      }

      const message =
        `${resultEmoji} Stream #${stream.id} ${isWin ? 'WON' : 'LOST'} round #${epoch}\n` +
        `💰 Bet: ${ethers.formatEther(bet.amount)} BNB on ${bet.position}\n` +
        `📉 Current Loss Streak: ${stream.consecutiveLosses}\n` +
        `⛓️ Daily Max Loss Streak: ${stream.dailyMaxConsecutiveLosses}\n` +
        `🔗 All-Time Max Loss Streak: ${stream.maxConsecutiveLosses}\n` +
        `📊 Win Rate: ${((stream.totalWins / stream.totalBets) * 100).toFixed(1)}% (${stream.totalWins}/${stream.totalBets})`;

      this.sendTelegramMessage(message);

      if (isWin) {
        await this.claimSingleBet(bet);
        // Сбрасываем ставку к базовой после выигрыша
        stream.currentAmount = this.calculateBaseBetAmount();
        stream.lossCount = 0;
      } else {
        stream.lossCount++;
        // Рассчитываем следующую ставку по выбранной стратегии
        stream.currentAmount = this.calculateNextBetAmount(stream);

        // Логирование информации о следующей ставке
        this.sendTelegramMessage(
          `🔄 Stream #${stream.id} next bet size: ${ethers.formatEther(stream.currentAmount)} BNB\n` +
            `Strategy: ${
              this.STRATEGY_TYPE === StrategyType.FIXED_PERCENTAGE
                ? 'Fixed Percentage'
                : `Modified Martingale (Loss count: ${stream.lossCount}/${this.FLAT_BET_COUNT})`
            }`,
        );
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
          `📉 Current Losses: ${stream.consecutiveLosses}\n` +
          `⛓️ Daily Max Loss Streak: ${stream.dailyMaxConsecutiveLosses}\n` +
          `🔗 All-Time Max Loss Streak: ${stream.maxConsecutiveLosses}\n` +
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

      // Получаем актуальный баланс после клейма
      const currentBalance = await this.provider.getBalance(
        this.wallet.address,
      );
      const balanceChange = currentBalance - this.initialBankroll;

      // Рассчитываем PnL
      const pnlUSD =
        parseFloat(ethers.formatEther(balanceChange)) * this.currentBnbPrice;

      this.sendTelegramMessage(
        `🏆 Claimed reward for round ${bet.epoch}\n` +
          `💸 Total Reward: $${(totalReward * this.currentBnbPrice).toFixed(2)}\n` +
          `💰 Current Balance: ${ethers.formatEther(currentBalance)} BNB\n` +
          `📈 Total PnL: $${pnlUSD.toFixed(2)}\n` +
          `🔄 Balance Change: ${ethers.formatEther(balanceChange)} BNB\n` +
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

        // Расширенная информация о ставке с добавлением USD стоимости
        const betAmountUsd =
          parseFloat(ethers.formatEther(stream.currentAmount)) *
          this.currentBnbPrice;
        this.sendTelegramMessage(
          `🎲 Stream #${stream.id} bet ${ethers.formatEther(stream.currentAmount)} BNB ($${betAmountUsd.toFixed(2)}) on ${position} (#${epoch})\n` +
            `📊 Strategy: ${
              this.STRATEGY_TYPE === StrategyType.FIXED_PERCENTAGE
                ? `Fixed ${this.FIXED_PERCENTAGE}% of balance`
                : `Modified Martingale (Loss count: ${stream.lossCount}/${this.FLAT_BET_COUNT})`
            }\n` +
            `📈 Round #${epoch} | Tx: ${tx.hash}`,
        );
      } catch (error) {
        this.sendTelegramMessage(
          `⚠️ Stream #${stream.id} bet error: ${error.reason || error.message}`,
        );
      }
    }
  }

  private calculateBetPosition(round: Round): 'Bull' | 'Bear' {
    // Улучшенная логика выбора позиции с учетом пропорций и минимального порога
    const bullAmount = Number(ethers.formatEther(round.bullAmount));
    const bearAmount = Number(ethers.formatEther(round.bearAmount));
    const totalAmount = bullAmount + bearAmount;

    // Если общая сумма ставок меньше минимального порога, выбираем случайно
    const MIN_VOLUME_THRESHOLD = 0.5; // BNB
    if (totalAmount < MIN_VOLUME_THRESHOLD) {
      return Math.random() < 0.5 ? 'Bull' : 'Bear';
    }

    // Вычисляем соотношение ставок
    const bullPercentage = (bullAmount / totalAmount) * 100;

    // Выбираем позицию с БОЛЬШЕЙ суммой ставок для лучшего соотношения риск/награда (так как боты ставят в последний момент на меньшую)
    return bullPercentage > 50 ? 'Bull' : 'Bear';
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
