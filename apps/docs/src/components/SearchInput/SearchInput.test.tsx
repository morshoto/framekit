import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { SearchInput } from './index';
it('exposes an accessible search input and reports changes', async () => { const onChange = vi.fn(); render(<SearchInput value="" onChange={onChange} />); await userEvent.type(screen.getByRole('combobox',{name:'Search documentation'}), 'a'); expect(onChange).toHaveBeenCalledWith('a'); });
