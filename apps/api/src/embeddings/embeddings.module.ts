import { Global, Module } from '@nestjs/common';
import { EMBEDDING_PROVIDER } from './embedding.provider';
import { LocalEmbeddingProvider } from './local-embedding.provider';

@Global()
@Module({
  providers: [{ provide: EMBEDDING_PROVIDER, useClass: LocalEmbeddingProvider }],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingsModule {}
