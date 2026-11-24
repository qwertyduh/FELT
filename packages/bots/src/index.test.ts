import { describe, expect, it } from 'vitest';
import { botsName } from './index';

describe('@felt/bots', () => {
  it('exports its name', () => {
    expect(botsName).toBe('@felt/bots');
  });
});
