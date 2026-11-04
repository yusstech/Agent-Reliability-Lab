import { startProviderPair } from '../../src/providers/harness.ts';
import { testDatabaseUrl } from './db.ts';

export const startTestProviders = () => startProviderPair(testDatabaseUrl());
