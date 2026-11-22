import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { EmptySearchState } from './index';
it('displays the provided state', () => { render(<EmptySearchState message="No results found." />); expect(screen.getByText('No results found.')).toBeInTheDocument(); });
