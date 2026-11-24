import { describe, expect, it } from 'vitest';
import { protocolName } from './index';

describe('@felt/protocol', () => {
  it('exports its name', () => {
    expect(protocolName).toBe('@felt/protocol');
  });
});
