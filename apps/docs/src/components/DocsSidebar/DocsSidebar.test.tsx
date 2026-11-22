import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DocsSidebar } from './index';
it('renders a labeled navigation landmark including groups', () => { render(<DocsSidebar groups={[{title:'Guides',items:[]}]} />); expect(screen.getByRole('navigation',{name:'Documentation'})).toHaveTextContent('Guides'); });
