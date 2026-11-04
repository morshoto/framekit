import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CodeBlock } from './index';
it('copies code and announces success', async () => { const user = userEvent.setup(); const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined); render(<CodeBlock code="example" language="ts" />); await user.click(screen.getByRole('button',{name:'Copy code'})); expect(writeText).toHaveBeenCalledWith('example'); expect(screen.getByRole('status')).toHaveTextContent('Copied'); });
