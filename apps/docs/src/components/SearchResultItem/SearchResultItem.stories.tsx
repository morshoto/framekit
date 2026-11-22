import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { SearchResultItem } from './index';
const meta = { component: SearchResultItem, args: { result: {title:'Blue lantern',href:'/en/docs/introduction/',excerpt:'A blue lantern example.'}, index:0, selected:true, query:'blue', onSelect:()=>{} } } satisfies Meta<typeof SearchResultItem>; export default meta; export const Selected: StoryObj<typeof meta> = {};
