'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { loadContributors, loadFunding, type Contributor } from '../lib/github-community';
import styles from './EnglishOverview.module.scss';

const fundingFile = 'https://github.com/morshoto/framekit/blob/main/.github/FUNDING.yml';
type Result<T> = { state: 'idle' | 'loading' | 'ready' | 'error'; data: T };

export function GitHubCommunity() {
  const [contributors, setContributors] = useState<Result<Contributor[]>>({ state: 'idle', data: [] });
  const [funding, setFunding] = useState<Result<string[]>>({ state: 'idle', data: ['morshoto'] });
  useEffect(() => {
    const controller = new AbortController();
    setContributors({ state: 'loading', data: [] });
    setFunding(current => ({ ...current, state: 'loading' }));
    loadContributors(controller.signal).then(data => {
      if (!controller.signal.aborted) setContributors({ state: 'ready', data });
    }).catch(() => {
      if (!controller.signal.aborted) setContributors({ state: 'error', data: [] });
    });
    loadFunding(controller.signal).then(data => {
      if (!controller.signal.aborted) setFunding({ state: 'ready', data });
    }).catch(() => {
      if (!controller.signal.aborted) setFunding(current => ({ ...current, state: 'error' }));
    });
    return () => controller.abort();
  }, []);

  return <section className={styles.community} aria-label="Support and contributors">
    <section className={styles['community-panel']} aria-labelledby="sponsor-title">
      <h2 id="sponsor-title">Support Framekit</h2>
      <p>Help keep Framekit growing.<br />Your sponsorship supports open source development.</p>
      {funding.state === 'ready' && funding.data.length > 0 && <ul className={`${styles.people} ${styles.maintainers}`} aria-label="Funded maintainers">
        {funding.data.map(login => <li key={login}><a className={styles.person} href={`https://github.com/sponsors/${login}`}><img src={`https://github.com/${login}.png?size=104`} width={52} height={52} alt="" loading="lazy" referrerPolicy="no-referrer" /><span>@{login}</span></a></li>)}
      </ul>}
      <a className={styles['sponsor-action']} href={funding.data.length ? `https://github.com/sponsors/${funding.data[0]}` : fundingFile}><span className={styles.heart} aria-hidden="true">♡</span>{funding.data.length ? 'Become a sponsor' : 'View funding options'}</a>
      <div className={styles['community-status']} role="status">{funding.state === 'loading' ? 'Checking GitHub funding settings…' : funding.state === 'error' ? 'Live funding settings unavailable. Showing the configured sponsorship link.' : funding.state === 'ready' && !funding.data.length ? 'No GitHub sponsorship account is configured.' : 'Support the maintainer on GitHub Sponsors.'}</div>
    </section>
    <section className={styles['community-panel']} aria-labelledby="contributors-title">
      <h2 id="contributors-title">Our contributors</h2>
      <p>Built with care, by the people who use it.<br />Thank you to everyone contributing to Framekit.</p>
      <ul className={`${styles.people} ${styles.contributors}`} aria-label="GitHub contributors">
        {contributors.data.map(person => <li key={person.login}><a className={styles.person} href={person.profile} title={`@${person.login}${person.bot ? ' · Automated contributor' : ''}`}><img src={person.avatar} width={48} height={48} alt="" loading="lazy" referrerPolicy="no-referrer" /><span className={styles['person-name']}>@{person.login}{person.bot && ' (automated contributor)'}</span>{person.bot && <span className={styles['bot-badge']} aria-hidden="true">⚙</span>}</a></li>)}
      </ul>
      <div className={styles['community-links']}><a href="https://github.com/morshoto/framekit/graphs/contributors">View all contributors ↗</a><Link href="/en/docs/development/">Become a contributor →</Link></div>
      <div className={styles['community-status']} role="status">{contributors.state === 'loading' ? 'Loading contributors from GitHub…' : contributors.state === 'error' ? 'GitHub is unavailable right now. View all contributors using the link above.' : contributors.state === 'ready' ? contributors.data.length ? 'Contributors from GitHub · Includes automated accounts · Up to 24 shown' : 'No public contributors listed yet. You can help shape what comes next.' : 'Contributors are listed on GitHub.'}</div>
    </section>
  </section>;
}
