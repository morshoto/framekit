import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SearchTrigger } from './index';
it('exposes a named disabled placeholder', () => { render(<SearchTrigger disabled />); expect(screen.getByRole('button',{name:'Search docs ⌘ / Ctrl K'})).toBeDisabled(); });
