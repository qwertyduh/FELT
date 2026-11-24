import { describe, expect, it } from 'vitest';
import { engineName } from './index';

describe('@felt/engine', () => {
  it('exports its name', () => {
    expect(engineName).toBe('@felt/engine');
  });
});
