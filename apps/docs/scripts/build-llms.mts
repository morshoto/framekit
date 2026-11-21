import { documents, getNavigation } from '../src/lib/docs/source';
import { generateLlms } from './generate-llms.mjs';

const ordered = getNavigation('en').map(item => documents.find(doc => doc.locale === 'en' && `/${doc.locale}/docs/${doc.slug}/` === item.href)!);
await generateLlms(ordered, 'content/docs', 'out');
