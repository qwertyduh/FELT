import { describe, expect, it } from 'vitest';
import { serverName } from './index';

describe('@felt/server', () => {
  it('exports its name', () => {
    expect(serverName).toBe('@felt/server');
  });
});
