import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import { assertStepRolesCanApprove } from './approval-workflows';

// QA 3: standalone organisations only have owner / admin / publisher / creator / viewer, so a
// workflow step for any other role (or a role that cannot approve) can never be completed.

describe('assertStepRolesCanApprove', () => {
  it('accepts roles that can approve in standalone mode', () => {
    expect(() =>
      assertStepRolesCanApprove(
        [{ role: 'publisher' }, { role: 'admin' }, { role: 'owner' }],
        'standalone',
      ),
    ).not.toThrow();
  });

  it.each(['client_reviewer', 'legal', 'viewer', 'creator'])(
    'refuses %s in standalone mode, naming the usable roles',
    (role) => {
      try {
        assertStepRolesCanApprove([{ role }], 'standalone');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toContain('owner, admin, publisher');
      }
    },
  );

  it('keeps free-form Core roles in core mode', () => {
    expect(() => assertStepRolesCanApprove([{ role: 'client_reviewer' }], 'core')).not.toThrow();
  });
});
