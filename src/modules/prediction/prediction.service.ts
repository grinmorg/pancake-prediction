import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
} from 'viem';
import { bsc } from 'viem/chains';
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
}

@Injectable()
export class PredictionService {
  private publicClient: any;
  private walletClient: any;
  private contract: any;
  private receiverTgId: string;

  private currentBetAmount: bigint;
  private lastBetPosition: 'Bull' | 'Bear' | null = null;
  private lastBetEpoch: number | null = null;
  private baseBetAmount: bigint;

  constructor(
    private readonly config: ConfigService,
    private readonly telegramService: TelegramService,
  ) {
    const chain = bsc;

    this.publicClient = createPublicClient({
      chain,
      transport: http(),
    });

    this.walletClient = createWalletClient({
      chain,
      transport: http(),
      key: this.config.get('WALLET_PRIVATE_KEY'),
    });

    this.contract = getContract({
      address: CONTRACT_ADDRESS,
      abi: predictionAbi,
      client: this.publicClient,
    });

    this.receiverTgId = this.config.get('RECIVER_TELEGRAM_ID');
  }

  async onModuleInit() {
    this.baseBetAmount = await this.contract.read.minBetAmount();
    this.currentBetAmount = this.baseBetAmount;
    this.listenToEvents();
    this.startBettingStrategy();
  }

  private listenToEvents() {
    this.contract.watchEvent.LockRound(
      {},
      {
        onLogs: (logs) => {
          logs.forEach((log) => {
            const message = `🔒 Round #${log.args.epoch} locked at price ${log.args.price}`;
            this.telegramService.sendMessage(this.receiverTgId, message);
          });
        },
      },
    );

    this.contract.watchEvent.EndRound(
      {},
      {
        onLogs: (logs) => {
          logs.forEach(async (log) => {
            const epoch = Number(log.args.epoch);
            if (this.lastBetEpoch === epoch) {
              const round = await this.getRoundData(epoch);
              const isWin = this.checkBetResult(round);

              if (isWin) {
                this.currentBetAmount = this.baseBetAmount;
                await this.claimWinnings(epoch);
                this.telegramService.sendMessage(
                  this.receiverTgId,
                  `✅ Won round #${epoch}! Reset bet to ${this.formatBnb(this.baseBetAmount)} BNB`,
                );
              } else {
                this.currentBetAmount = (this.currentBetAmount * 200n) / 100n; // x2
                this.telegramService.sendMessage(
                  this.receiverTgId,
                  `❌ Lost round #${epoch}. Next bet: ${this.formatBnb(this.currentBetAmount)} BNB`,
                );
              }

              this.lastBetEpoch = null;
              this.lastBetPosition = null;
            }
          });
        },
      },
    );
  }

  private async claimWinnings(epoch: number) {
    try {
      const { request } = await this.publicClient.simulateContract({
        ...this.contract,
        functionName: 'claim',
        args: [[epoch]],
        account: this.walletClient.account.address,
      });

      const txHash = await this.walletClient.writeContract(request);
      this.telegramService.sendMessage(
        this.receiverTgId,
        `🏆 Claimed rewards for round #${epoch} | Tx: ${txHash}`,
      );
    } catch (err) {
      this.telegramService.sendMessage(
        this.receiverTgId,
        `⚠️ Failed to claim rewards: ${err.message}`,
      );
    }
  }

  private checkBetResult(round: Round): boolean {
    if (!this.lastBetPosition || !round.oracleCalled) return false;

    const isBullWin = round.closePrice > round.lockPrice;
    const isBearWin = round.closePrice < round.lockPrice;

    return (
      (this.lastBetPosition === 'Bull' && isBullWin) ||
      (this.lastBetPosition === 'Bear' && isBearWin)
    );
  }

  private async startBettingStrategy() {
    setInterval(async () => {
      try {
        const currentEpoch = Number(await this.contract.read.currentEpoch());
        const round = await this.getRoundData(currentEpoch);

        if (this.isBettable(round)) {
          await this.placeBet(currentEpoch);
        }
      } catch (err) {
        this.telegramService.sendMessage(
          this.receiverTgId,
          `❌ Error: ${err.message}`,
        );
      }
    }, 30_000);
  }

  private isBettable(round: Round): boolean {
    const now = Math.floor(Date.now() / 1000);
    return now > round.startTimestamp && now < round.lockTimestamp - 5;
  }

  private async getRoundData(epoch: number): Promise<Round> {
    const roundData = await this.contract.read.rounds([BigInt(epoch)]);

    return {
      epoch: Number(roundData[0]),
      startTimestamp: Number(roundData[1]),
      lockTimestamp: Number(roundData[2]),
      closeTimestamp: Number(roundData[3]),
      lockPrice: roundData[4],
      closePrice: roundData[5],
      totalAmount: roundData[8],
      bullAmount: roundData[9],
      bearAmount: roundData[10],
      oracleCalled: roundData[13],
    };
  }

  private async placeBet(epoch: number) {
    const round = await this.getRoundData(epoch);

    const treasuryFee = (round.totalAmount * 300n) / 10000n;
    const prizePool = round.totalAmount - treasuryFee;

    const bullPayout =
      round.bullAmount > 0n ? prizePool / round.bullAmount : 0n;
    const bearPayout =
      round.bearAmount > 0n ? prizePool / round.bearAmount : 0n;

    const position = bullPayout > bearPayout ? 'Bull' : 'Bear';

    const balance = await this.publicClient.getBalance({
      address: this.walletClient.account.address,
    });

    if (balance < this.currentBetAmount) {
      this.telegramService.sendMessage(
        this.receiverTgId,
        `⚠️ Insufficient balance for bet: ${this.formatBnb(this.currentBetAmount)} BNB`,
      );
      return;
    }

    try {
      const { request } = await this.publicClient.simulateContract({
        ...this.contract,
        functionName: position === 'Bull' ? 'betBull' : 'betBear',
        args: [BigInt(epoch)],
        value: this.currentBetAmount,
        account: this.walletClient.account.address,
      });

      const txHash = await this.walletClient.writeContract(request);

      this.lastBetPosition = position;
      this.lastBetEpoch = epoch;

      this.telegramService.sendMessage(
        this.receiverTgId,
        `🎲 Placed ${this.formatBnb(this.currentBetAmount)} BNB on ${position} (#${epoch}) | Tx: ${txHash}`,
      );
    } catch (err) {
      this.telegramService.sendMessage(
        this.receiverTgId,
        `⚠️ Failed to place bet: ${err.message}`,
      );
    }
  }

  private formatBnb(value: bigint): string {
    return Number(value / 10n ** 12n) / 1_000_000 + '';
  }
}
