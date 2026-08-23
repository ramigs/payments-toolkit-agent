import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { getPrompt, readStdin } from '../../src/prompt.js';

function stubStdin(chunks: string[]): () => void {
  const original = process.stdin;
  Object.defineProperty(process, 'stdin', {
    value: Readable.from(chunks),
    configurable: true,
  });
  return () => {
    Object.defineProperty(process, 'stdin', {
      value: original,
      configurable: true,
    });
  };
}

describe('getPrompt', () => {
  it('joins CLI args into a single prompt', async () => {
    await expect(getPrompt(['Is', '4111111111111111', 'valid?'])).resolves.toBe(
      'Is 4111111111111111 valid?',
    );
  });

  it('trims surrounding whitespace from the args', async () => {
    await expect(getPrompt(['  hello world  '])).resolves.toBe('hello world');
  });

  it('falls back to stdin when no args are given', async () => {
    const restore = stubStdin(['piped ', 'question\n']);
    try {
      await expect(getPrompt([])).resolves.toBe('piped question');
    } finally {
      restore();
    }
  });
});

describe('readStdin', () => {
  it('concatenates and trims all stdin chunks', async () => {
    const restore = stubStdin([' foo', ' bar ']);
    try {
      await expect(readStdin()).resolves.toBe('foo bar');
    } finally {
      restore();
    }
  });
});
