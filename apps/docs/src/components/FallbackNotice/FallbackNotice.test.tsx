import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { FallbackNotice } from './index';
it('announces a locale fallback when requested', () => { history.pushState({}, '', '/?fallback=1'); render(<FallbackNotice message="Showing overview" />); expect(screen.getByRole('status')).toHaveTextContent('Showing overview'); history.replaceState({}, '', '/'); });
