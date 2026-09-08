import assert from 'node:assert/strict';
import test from 'node:test';
import { normalize } from '../packages/rules/index.mjs';

test('normalization trims outer spaces', () => assert.equal(normalize('  HELLO  '), 'HELLO'));
