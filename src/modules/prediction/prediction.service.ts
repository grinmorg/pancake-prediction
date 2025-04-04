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
      if (this.lastBetEpoch === Number(epoch)) {
        const round = await this.getRoundData(Number(epoch));
        const isWin = this.checkBetResult(round);
        await this.handleRoundResult(Number(epoch), isWin);
        this.resetBetState();
      }
    });

    this.provider.on('error', (error) => {
      this.logger.error('Provider error:', error);
      this.sendTelegramMessage(`⚠️ Provider error: ${error.message}`);
    });
  }

  private async handleRoundResult(epoch: number, isWin: boolean) {
    if (isWin) {
      this.currentBetAmount = this.baseBetAmount;
      await this.claimWinnings(epoch);
      this.sendTelegramMessage(
        `✅ Won round #${epoch}! Reset to ${ethers.formatEther(this.baseBetAmount)} BNB`,
      );
    } else {
      this.currentBetAmount *= BigInt(2.5);
      this.sendTelegramMessage(
        `❌ Lost round #${epoch}. Next bet: ${ethers.formatEther(this.currentBetAmount)} BNB`,
      );
    }
  }

  private resetBetState() {
    this.lastBetEpoch = null;
    this.lastBetPosition = null;
  }

  private async claimWinnings(epoch: number) {
    try {
      const tx = await this.contract.claim([epoch]);
      this.sendTelegramMessage(
        `🏆 Claimed rewards for round #${epoch} | Tx: ${tx.hash}`,
      );
      await tx.wait();
    } catch (error) {
      this.sendTelegramMessage(
        `⚠️ Failed to claim rewards: ${error.reason || error.message}`,
      );
    }
  }

  private checkBetResult(round: Round): boolean {
    if (!this.lastBetPosition || !round.oracleCalled) return false;

    return (
      (this.lastBetPosition === 'Bull' && round.closePrice > round.lockPrice) ||
      (this.lastBetPosition === 'Bear' && round.closePrice < round.lockPrice)
    );
  }

  private async startBettingStrategy() {
    setInterval(async () => {
      try {
        const currentEpoch = Number(await this.contract.currentEpoch());
        const round = await this.getRoundData(currentEpoch);
        const now = Math.floor(Date.now() / 1000);

        this.logger.debug(
          `Checking round #${currentEpoch} | Now: ${now} | Lock: ${round.lockTimestamp} | Remaining: ${round.lockTimestamp - now}s`,
        );

        if (this.isBettable(round)) {
          await this.placeBet(currentEpoch);
        }
      } catch (error) {
        this.sendTelegramMessage(
          `❌ Strategy error: ${error.reason || error.message}`,
        );
      }
    }, 1_000); // Проверяем каждую секунду
  }

  private isBettable(round: Round): boolean {
    const now = Math.floor(Date.now() / 1000);

    return (
      !round.oracleCalled && // Раунд еще не закрыт
      now >= round.lockTimestamp - 5 && // За 5 секунд до блокировки
      now < round.lockTimestamp // Еще не заблокирован
    );
  }

  private async getRoundData(epoch: number): Promise<Round> {
    const roundData = await this.contract.rounds(epoch);
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
      canBet: roundData[11], // Индекс поля canBet в ABI
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
      // Добавляем проверку на возможность ставки
      const round = await this.getRoundData(epoch);
      if (!round.canBet) {
        this.logger.debug(`Betting not allowed for epoch ${epoch}`);
        return;
      }

      const method = position === 'Bull' ? 'betBull' : 'betBear';

      // Увеличиваем газ и устанавливаем правильный gasPrice
      const gasEstimate = await this.contract[method].estimateGas(epoch, {
        value: betAmount,
      });

      const nonce = await this.provider.getTransactionCount(
        this.wallet.address,
        'latest',
      );

      const tx = await this.contract[method](epoch, {
        value: betAmount,
        gasLimit: gasEstimate, // Запас газа
        nonce,
      });

      // Блокируем повторные ставки сразу после успешной отправки
      this.lastBetPosition = position;
      this.lastBetEpoch = epoch;

      this.sendTelegramMessage(
        `🎲 Placed ${ethers.formatEther(betAmount)} BNB on ${position} (#${epoch}) | Tx: ${tx.hash}`,
      );

      const receipt = await tx.wait();
      if (receipt.status === 0) {
        throw new Error('Transaction reverted');
      }
    } catch (error) {
      // Сбрасываем состояние при ошибке
      this.resetBetState();
      this.sendTelegramMessage(
        `⚠️ Failed to place bet: ${error.reason || error.message}`,
      );
      this.logger.error('Bet execution failed', error);
    }
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
