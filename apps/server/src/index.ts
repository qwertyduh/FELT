import { engineName } from '@felt/engine';
import { protocolName } from '@felt/protocol';

export const serverName = '@felt/server';
export const serverDeps: readonly string[] = [engineName, protocolName];
