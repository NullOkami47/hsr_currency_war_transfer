import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { createRolesHandler } from '../src/http.mjs';

test('browser catalogue loader uses the canonical API and renders roles and bonds', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const loader = source.slice(source.indexOf('async function loadRoles()'), source.indexOf('\nfunction statusPanel', source.indexOf('async function loadRoles()')));
  const catalogue = { roles: [{ id: 'role' }], bonds: [{ id: 'bond' }] };
  const handler = createRolesHandler({ fetchChinaRoleOptionsFn: async () => catalogue });
  let roleRenders = 0, bondRenders = 0;
  const context = vm.createContext({
    state: {}, elements: { 'role-status': {}, 'bond-status': {} }, t: x => x,
    renderRoleGrid: () => roleRenders++, renderBondGrid: () => bondRenders++,
    updateRoleTrigger() {}, updateBondTrigger() {},
    fetch: async url => {
      const response = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
      await handler({ method: 'GET', url, headers: {} }, response);
      return { ok: response.statusCode === 200, json: async () => response.body };
    },
  });
  assert.equal(await vm.runInContext(loader + '\nloadRoles()', context), true);
  assert.equal(context.state.rolesById.has('role'), true);
  assert.equal(context.state.bondsById.has('bond'), true);
  assert.equal(roleRenders, 1);
  assert.equal(bondRenders, 1);
});
