import { describe, expect, it } from 'vitest';
import { webName } from './index';

describe('@felt/web', () => {
  it('exports its name', () => {
    expect(webName).toBe('@felt/web');
  });
});
