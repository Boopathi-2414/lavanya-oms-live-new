const project = (import.meta.env?.VITE_SUPABASE_URL || 'local').replace(/^https?:\/\//,'').split('.')[0];
// Reuse the authorised test project's cache when upgrading, isolate other projects.
export const CACHE_PREFIX = project === 'jfynrmusohnbsmlhainm' ? 'lavanya_test_jfynrmusohnbsmlhainm_' : `lavanya_${project}_`;
