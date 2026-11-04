import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Breadcrumbs } from './index';
it('exposes the current page', () => { render(<Breadcrumbs current="Overview" />); expect(screen.getByText('Overview')).toHaveAttribute('aria-current','page'); });
