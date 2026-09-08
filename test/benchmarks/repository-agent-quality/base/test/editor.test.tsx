import React from 'react';
import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { Editor } from '../src/editor';
test('blank input stays enabled', () => { render(<Editor value="" />); expect(screen.getByRole('button').disabled).toBe(false); });
test('filled input stays enabled', () => { render(<Editor value="note" />); expect(screen.getByRole('button').disabled).toBe(false); });
