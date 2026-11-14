'use client';
import { useEffect, useRef, type RefObject } from 'react';
import styles from './EnglishOverview.module.scss';

export function WorkflowDemo() {
  const figure = useRef<HTMLElement>(null);
  useWorkflowMotion(figure);
  return (<figure ref={figure} className={styles['demo-wrap']} aria-labelledby="demo-caption"><div data-workflow-demo className={styles['demo']}><div className={styles['demo-bar']}><div className={styles['window-dots']} aria-hidden="true"><i></i><i></i><i></i></div><span>Framekit / A conversation before the cut</span><span className={styles['demo-label']}>Concept</span></div><div className={styles['demo-body']}><aside className={styles['demo-sidebar']} aria-label="Illustrated project navigation"><div className={styles['project-name']}><span className={styles['small-mark']} aria-hidden="true">⌑</span> Framekit</div><div className={styles['sidebar-label']}>Example project</div><div className={styles['sidebar-item'] + ' ' + styles['active']}>▤ &nbsp; Overview</div><div className={styles['sidebar-item']}>▦ &nbsp; Media</div><div className={styles['sidebar-item']}>≋ &nbsp; Timeline</div><div className={styles['sidebar-label']}>Workflow</div><div className={styles['sidebar-item']}>◇ &nbsp; Preview changes</div><div className={styles['sidebar-item']}>↗ &nbsp; Render output</div></aside><div className={styles['demo-main']}><div className={styles['editor-top']}>A day outside <span>Illustrative project</span></div><div className={styles['monitor']} aria-label="Abstract landscape illustration"><div className={styles['landscape']} aria-hidden="true"></div><span className={styles['frame-label']}>your media, your project</span></div><div className={styles['transport']} aria-hidden="true"><span>00:00:12:00</span><span>▷</span><span>16:9</span></div><div className={styles['timeline']} aria-label="Illustrated video and audio tracks"><div className={styles['ruler']} aria-hidden="true"><span>00:00</span><span>00:10</span><span>00:20</span><span>00:30</span></div><div className={styles['track']}><div className={styles['clip']}>morning.mov</div><div className={styles['clip'] + ' ' + styles['short']}>walk.mov</div><div className={styles['clip']}>landscape.mov</div></div><div className={styles['audio']} aria-hidden="true"></div><div className={styles['playhead']} aria-hidden="true"></div></div></div><div className={styles['demo-chat']}><div className={styles['chat-title']}>You + Codex <span>Example prompt</span></div><div data-workflow-prompt className={styles['bubble']}>Check the connection status and tell me which editor and capabilities are available. Do not edit anything.</div><div className={styles['assistant-label']}>What you’ll learn</div><p>Understand your setup before making a change.</p><ul className={styles['checklist']}><li data-workflow-step><b aria-hidden="true">↳</b> Connection state</li><li data-workflow-step><b aria-hidden="true">↳</b> Connected editor</li><li data-workflow-step><b aria-hidden="true">↳</b> Available operations</li></ul><div className={styles['chat-note']}>Your first step is inspection.</div></div></div></div><figcaption className={styles['demo-caption']} id="demo-caption"><span>Workflow illustration · A visual explanation of Framekit, not an application screenshot.</span><span>Inspect. Preview. Execute. Verify.</span></figcaption></figure>);
}

function useWorkflowMotion(figure: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = figure.current;
    const demo = root?.querySelector<HTMLElement>('[data-workflow-demo]');
    if (!root || !demo) return;
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const steps = [...root.querySelectorAll<HTMLElement>('[data-workflow-step]')];
    const animations = new Set<Animation>();
    let frame = 0;
    const update = () => {
      frame = 0;
      if (preference.matches) {
        demo.removeAttribute('data-scroll-ready');
        demo.style.removeProperty('--demo-progress');
        steps.forEach(step => step.removeAttribute('data-current'));
        return;
      }
      const bounds = demo.getBoundingClientRect();
      const progress = Math.max(0, Math.min(1, (innerHeight * .88 - bounds.top) / (bounds.height + innerHeight * .38)));
      demo.dataset.scrollReady = '';
      demo.style.setProperty('--demo-progress', progress.toFixed(4));
      const current = Math.min(steps.length - 1, Math.floor(progress * steps.length));
      steps.forEach((step, index) => step.toggleAttribute('data-current', current === index));
    };
    const queue = () => { if (!frame) frame = requestAnimationFrame(update); };
    const reveal = (element: HTMLElement, delay = 0) => {
      if (preference.matches || !element.animate) return;
      const animation = element.animate([
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 600, delay, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
      animations.add(animation);
      animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
    };
    let observer: IntersectionObserver | undefined;
    if (!preference.matches && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer?.unobserve(entry.target);
          reveal(demo);
          const bubble = root.querySelector<HTMLElement>('[data-workflow-prompt]');
          if (bubble) reveal(bubble, 180);
          steps.forEach((step, index) => reveal(step, 450 + index * 150));
        }
      }, { threshold: .12 });
      observer.observe(demo);
    }
    const change = () => {
      if (preference.matches) {
        animations.forEach(animation => animation.cancel());
        animations.clear();
        observer?.disconnect();
      }
      if (frame) cancelAnimationFrame(frame);
      update();
    };
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue, { passive: true });
    preference.addEventListener('change', change);
    update();
    return () => {
      window.removeEventListener('scroll', queue);
      window.removeEventListener('resize', queue);
      preference.removeEventListener('change', change);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      animations.forEach(animation => animation.cancel());
    };
  }, [figure]);
}
