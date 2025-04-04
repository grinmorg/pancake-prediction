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

interface BetHistory {
  epoch: number;
  position: 'Bull' | 'Bear';
  amount: bigint;
  claimed: boolean;
}

@Injectable()
export class PredictionService implements OnModuleInit {
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

  constructor(
    private readonly config: ConfigService,
    private readonly telegramService: TelegramService,
  ) {}

  async onModuleInit() {
    await this.initializeProvider();
    await this.initializeContract();
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
    this.contract.on('LockRound', (epoch, price) => {
      this.telegramService.sendMessage(
        this.config.get('RECEIVER_TELEGRAM_ID'),
        `🔒 Round #${epoch} locked at ${this.formatPrice(price)}`,
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

    if (betsForRound.length === 0) return;

    const anyWin = betsForRound.some((bet) =>
      this.checkSingleBetResult(bet, round),
    );

    if (anyWin) {
      this.currentBetAmount = this.baseBetAmount;
      this.sendTelegramMessage(
        `✅ Won round #${epoch}! Reset to ${ethers.formatEther(this.baseBetAmount)} BNB`,
      );
    } else {
      this.currentBetAmount = (this.currentBetAmount * 25n) / 10n;
      this.sendTelegramMessage(
        `❌ Lost round #${epoch}. Next bet: ${ethers.formatEther(this.currentBetAmount)} BNB`,
      );
    }
  }

  private async checkAndClaimWinnings() {
    if (this.betHistory.length < this.WIN_STREAK_TO_CLAIM) return;

    // Находим последние 3 не заклеймленные ставки
    const unclaimedBets = this.betHistory.filter((b) => !b.claimed);
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
          await this.placeBet(bettingRound.epoch);
        }
      } catch (error) {
        this.sendTelegramMessage(
          `❌ Strategy error: ${error.reason || error.message}`,
        );
      }
    }, 1_000);
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
      now >= round.lockTimestamp - 5 &&
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

  private async placeBet(epoch: number) {
    const round = await this.getRoundData(epoch);
    const { position, betAmount } = this.calculateBetPosition(round);

    if (await this.hasSufficientBalance(betAmount)) {
      await this.executeBet(epoch, position, betAmount);
    }
  }

  private calculateBetPosition(round: Round): {
    position: 'Bull' | 'Bear';
    betAmount: bigint;
  } {
    const treasuryFee = (round.totalAmount * 300n) / 10000n;
    const prizePool = round.totalAmount - treasuryFee;

    const bullPayout =
      round.bullAmount > 0n ? prizePool / round.bullAmount : 0n;
    const bearPayout =
      round.bearAmount > 0n ? prizePool / round.bearAmount : 0n;

    return {
      position: bullPayout > bearPayout ? 'Bull' : 'Bear',
      betAmount: this.currentBetAmount,
    };
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

  private async executeBet(
    epoch: number,
    position: 'Bull' | 'Bear',
    betAmount: bigint,
  ) {
    try {
      const round = await this.getRoundData(epoch);
      if (!round.canBet) return;

      const method = position === 'Bull' ? 'betBull' : 'betBear';

      const [gasEstimate, nonce] = await Promise.all([
        this.contract[method].estimateGas(epoch, { value: betAmount }),
        this.provider.getTransactionCount(this.wallet.address, 'latest'),
      ]);

      const tx = await this.contract[method](epoch, {
        value: betAmount,
        gasLimit: (gasEstimate * 120n) / 100n,
        nonce: nonce,
      });

      this.betHistory.push({
        epoch,
        position,
        amount: betAmount,
        claimed: false,
      });

      this.lastBetPosition = position;
      this.lastBetEpoch = epoch;

      await tx.wait(1);
      this.sendTelegramMessage(
        `🎲 Bet ${ethers.formatEther(betAmount)} BNB on ${position} (#${epoch}) | Tx: ${tx.hash}`,
      );

      this.cleanupBetHistory();
    } catch (error) {
      this.resetBetState();
      this.logger.error('Bet failed', error);
      this.sendTelegramMessage(
        `⚠️ Bet error: ${error.reason || error.message}`,
      );
    }
  }

  private cleanupBetHistory() {
    if (this.betHistory.length > 50) {
      this.betHistory = this.betHistory.slice(-50);
    }
  }

  private resetBetState() {
    this.lastBetEpoch = null;
    this.lastBetPosition = null;
  }

  private sendTelegramMessage(message: string) {
    this.telegramService.sendMessage(
      this.config.get('RECEIVER_TELEGRAM_ID'),
      message,
    );
  }

  private formatPrice(value: bigint): string {
    return Number(value / 10n ** 6n) / 100 + '';
  }
}
