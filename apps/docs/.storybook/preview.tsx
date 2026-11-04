import type { Preview } from '@storybook/nextjs-vite';
import { withThemeByDataAttribute } from '@storybook/addon-themes';
import '../src/styles/globals.scss';

const preview: Preview = {
  decorators: [withThemeByDataAttribute({ themes: { light: 'light', dark: 'dark' }, defaultTheme: 'light', attributeName: 'data-theme' })],
  parameters: {
    layout: 'centered',
    viewport: { options: Object.fromEntries([320, 375, 768, 1024, 1440].map(width => [`width${width}`, { name: `${width}px`, styles: { width: `${width}px`, height: '900px' } }])) },
  },
};
export default preview;
