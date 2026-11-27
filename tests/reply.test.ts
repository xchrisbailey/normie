// Reply, reply all and forward (#41): recipients, subjects, threading headers, quoting.
import { describe, expect, it } from 'vitest';
import { planReply, prefixed } from '../src/core/reply';
import type { Original } from '../src/core/reply';

const me = { name: 'Me', address: 'me@example.com' };
const ada = { name: 'Ada', address: 'ada@example.com' };
const grace = { name: 'Grace', address: 'grace@example.com' };
const alan = { name: 'Alan', address: 'alan@example.com' };
const when = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

const original = (over: Partial<Original> = {}): Original => ({
  messageId: '<m2@example.com>', references: ['<m1@example.com>'], from: ada, replyTo: [], to: [me, grace], cc: [alan],
  subject: 'Lunch', date: Date.UTC(2026, 10, 27, 12), text: 'Friday?\nNoon works.', attachments: [], ...over,
});

describe('replying', () => {
  it('replies to the sender, from the Identity the message was sent to, with threading headers', () => {
    const r = planReply('reply', original(), [{ address: 'other@example.com' }, me], when);
    expect(r).toMatchObject({ from: me, to: [ada], cc: [], subject: 'Re: Lunch', inReplyTo: '<m2@example.com>', references: ['<m1@example.com>', '<m2@example.com>'] });
    expect(r.body).toBe('\n\nOn Nov 27, 2026, 12:00 PM, Ada <ada@example.com> wrote:\n> Friday?\n> Noon works.');
  });

  it('uses Reply-To when there is one', () => {
    expect(planReply('reply', original({ replyTo: [{ address: 'list@example.com' }] }), [me], when).to).toEqual([{ address: 'list@example.com' }]);
  });

  it('reply all adds everyone else, and never me', () => {
    const r = planReply('replyAll', original(), [me], when);
    expect(r.to).toEqual([ada, grace]);
    expect(r.cc).toEqual([alan]);
  });

  it('replying to my own message goes to the people I wrote to', () => {
    const r = planReply('replyAll', original({ from: me, to: [ada], cc: [grace] }), [me], when);
    expect(r.to).toEqual([ada]);
    expect(r.cc).toEqual([grace]);
    expect(r.from).toEqual(me);
  });

  it('keeps a subject that already says Re or Fwd', () => {
    expect(prefixed('RE: Lunch', 'reply')).toBe('RE: Lunch');
    expect(prefixed('Fw: Lunch', 'forward')).toBe('Fw: Lunch');
    expect(prefixed('Re: Lunch', 'forward')).toBe('Fwd: Re: Lunch');
  });
});

describe('forwarding', () => {
  it('starts with no recipients, quotes the headers, and carries the attachments', () => {
    const file = { filename: 'menu.pdf', contentType: 'application/pdf', content: new Uint8Array([1, 2]) };
    const f = planReply('forward', original({ attachments: [file] }), [me], when);
    expect(f).toMatchObject({ to: [], cc: [], subject: 'Fwd: Lunch', attachments: [file] });
    expect(f.body).toContain('---------- Forwarded message ---------\nFrom: Ada <ada@example.com>');
    expect(f.body).toContain('Cc: Alan <alan@example.com>');
    expect(f.body).toContain('Friday?\nNoon works.');
    expect('inReplyTo' in f).toBe(false);
  });
});

describe('Identities on reply', () => {
  it('answers from the custom-domain Identity the message was sent to, not the login', () => {
    const login = { address: 'me@icloud.com' };
    const custom = { name: 'Chris', address: 'chris@srcery.example' };
    const r = planReply('reply', original({ to: [{ address: 'CHRIS@srcery.example' }], cc: [] }), [login, custom], when);
    expect(r.from).toEqual(custom);
    expect(r.to).toEqual([ada]);
  });
});
