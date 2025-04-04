import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as TelegramBot from 'node-telegram-bot-api';

@Injectable()
export class TelegramService implements OnModuleInit {
  private bot: TelegramBot;
  private readonly logger = new Logger(TelegramService.name);

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    await this.initBot();
  }

  private async initBot() {
    const token = this.configService.get('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.error('TELEGRAM_BOT_TOKEN не найден!');
      return;
    }

    this.bot = new TelegramBot(token, { polling: true });

    this.bot.onText(/\/start/, (msg) => {
      this.bot.sendMessage(msg.chat.id, 'Бот приветствует!');
    });

    this.logger.log('Telegram бот успешно инициализирован');
  }

  async sendMessage(chatId: string, message: string) {
    if (!this.bot) {
      this.logger.error(
        'Телеграм бота не инициализирован, поэтому сообщение не отправилось...',
      );
      return;
    }

    try {
      await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (error) {
      this.logger.error(`Ошибка отправки сообщения: ${error.message}`);
      throw error;
    }
  }
}
