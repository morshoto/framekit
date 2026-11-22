import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SearchResultItem } from './index';
it('renders excerpts as text rather than HTML', () => { render(<SearchResultItem result={{title:'Example',href:'/en/',excerpt:'<img src=x onerror=alert(1)>'}} index={0} selected query="" onSelect={()=>{}} />); expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument(); expect(document.querySelector('img')).toBeNull(); });
