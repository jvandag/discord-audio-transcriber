import { expect, it } from 'vitest';
import { command } from '../src/discord/commands.js';
import { controlView, menuMembers } from '../src/discord/views.js';
import { session } from './helpers.js';
const members = Array.from({ length: 30 }, (_, i) => ({
  userId: String(i).padStart(3, '0'),
  displayName: `Member ${String(i).padStart(2, '0')}`,
  username: `user${i}`,
}));
it.each([0, 1, 25, 26, 30])('builds valid control rows for %i members', (count) => {
  const view = controlView(
    session(),
    members.slice(0, count),
    { pending: 0, done: 0, failed: 0 },
    0,
    () => undefined,
  );
  const menu = view.components[1]!.toJSON().components[0]!;
  expect('options' in menu && menu.options.length).toBe(Math.max(1, Math.min(count, 25)));
  expect(view.components[0]!.toJSON().components).toHaveLength(2);
});
it('selects a stable first 25 and disables ended controls', () => {
  expect(menuMembers([...members].reverse()).map((member) => member.userId)).toEqual(
    members.slice(0, 25).map((member) => member.userId),
  );
  const view = controlView(
    session({ state: 'completed' }),
    members,
    { pending: 0, done: 0, failed: 0 },
    0,
    () => undefined,
  );
  expect(view.components[0]!.toJSON().components[1]?.disabled).toBe(true);
  expect(view.components[1]!.toJSON().components[0]?.disabled).toBe(true);
});
it('serializes slash commands within Discord choice limits', () => {
  expect(command.toJSON().name).toBe('transcript');
});
