import { Global, Module } from '@nestjs/common';
import { PredictionService } from './prediction.service';

@Global()
@Module({
  providers: [PredictionService],
  exports: [PredictionService],
})
export class PredictionModule {}
