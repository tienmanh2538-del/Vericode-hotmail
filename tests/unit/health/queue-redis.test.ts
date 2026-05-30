import { describe, it, expect } from 'vitest';

import { classifyQueueRedis } from '@/services/health/health.service';

describe('classifyQueueRedis', () => {
  it('PASS when REDIS_URL is configured', () => {
    const result = classifyQueueRedis(true, 'staging');
    expect(result.status).toBe('PASS');
    // Never leaks the URL itself.
    expect(result.detail).not.toMatch(/redis:\/\//);
  });

  it('WARNING when unset on staging/production', () => {
    expect(classifyQueueRedis(false, 'staging').status).toBe('WARNING');
    expect(classifyQueueRedis(false, 'production').status).toBe('WARNING');
  });

  it('UNKNOWN when unset in local development', () => {
    expect(classifyQueueRedis(false, 'development').status).toBe('UNKNOWN');
  });
});
