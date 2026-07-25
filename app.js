const STORAGE_PREFIX = 'myeden-jd:'

const state = {
  data: null,
  bookmarks: readJSON('bookmarks', []),
  compare: readJSON('compare', []),
  recent: readJSON('recent', []),
  theme: localStorage.getItem(`${STORAGE_PREFIX}theme`) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  installPrompt: null,
  loading: false,
  directory: { query: '', department: '', level: '' },
  mode: 'employee',
  employeeData: null,
  adminConfig: null,
  adminFailures: 0,
  adminLockUntil: 0,
  adminTimer: null,
}

const el = {
  page: document.querySelector('#page'),
  status: document.querySelector('#status-region'),
  sidebar: document.querySelector('#sidebar'),
  sidebarScrim: document.querySelector('#sidebar-scrim'),
  departmentNav: document.querySelector('#department-nav'),
  compareButton: document.querySelector('#compare-button'),
  themeButton: document.querySelector('#theme-button'),
  installButton: document.querySelector('#install-button'),
  sidebarVersion: document.querySelector('#sidebar-version'),
  toast: document.querySelector('#toast'),
  modeBadge: document.querySelector('#mode-badge'),
  adminButton: document.querySelector('#admin-button'),
  adminDialog: document.querySelector('#admin-dialog'),
  adminDialogClose: document.querySelector('#admin-dialog-close'),
  adminLoginForm: document.querySelector('#admin-login-form'),
  adminUsername: document.querySelector('#admin-username'),
  adminPassword: document.querySelector('#admin-password'),
  adminLoginError: document.querySelector('#admin-login-error'),
  adminLoginSubmit: document.querySelector('#admin-login-submit'),
  showAdminPassword: document.querySelector('#show-admin-password'),
}


function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character])
}

function attr(value) {
  return esc(value).replace(/\r?\n/g, '&#10;')
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme
  localStorage.setItem(`${STORAGE_PREFIX}theme`, state.theme)
  if (el.themeButton) {
    const nextTheme = state.theme === 'dark' ? 'light' : 'dark'
    el.themeButton.textContent = state.theme === 'dark' ? '☀' : '◐'
    el.themeButton.setAttribute('aria-label', `Switch to ${nextTheme} mode`)
    el.themeButton.title = `Switch to ${nextTheme} mode`
  }
}

function setLoading(isLoading) {
  state.loading = Boolean(isLoading)
  document.body.setAttribute('aria-busy', String(state.loading))
  if (el.status) el.status.innerHTML = state.loading ? '<div class="status-loading" aria-label="Loading the Job Description Manual"></div>' : ''
}

function showError(message) {
  if (!el.status) return
  el.status.innerHTML = `<div class="status-error" role="alert"><strong>Portal loading error:</strong> ${esc(message || 'Unknown error.')} <button id="reload-portal" type="button">Reload</button></div>`
  document.querySelector('#reload-portal')?.addEventListener('click', () => location.reload())
}

let toastTimer
function showToast(message) {
  if (!el.toast) return
  clearTimeout(toastTimer)
  el.toast.textContent = message
  el.toast.classList.remove('hidden')
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2400)
}

function readJSON(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_PREFIX + key))
    return value ?? fallback
  } catch {
    return fallback
  }
}

function writeJSON(key, value) {
  localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value))
}


function bytesFromBase64(value) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function loadAdminConfig() {
  if (state.adminConfig) return state.adminConfig
  const response = await fetch('./admin-config.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`Admin configuration returned HTTP ${response.status}`)
  state.adminConfig = await response.json()
  return state.adminConfig
}

async function decryptAdminPayload(password, payload) {
  if (!window.crypto?.subtle) throw new Error('This browser does not support encrypted admin access.')
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bytesFromBase64(payload.salt), iterations: payload.iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytesFromBase64(payload.iv), additionalData: bytesFromBase64(payload.aad) },
    key,
    bytesFromBase64(payload.ciphertext),
  )
  return JSON.parse(new TextDecoder().decode(decrypted))
}

function setAdminError(message = '') {
  if (!el.adminLoginError) return
  el.adminLoginError.textContent = message
  el.adminLoginError.classList.toggle('hidden', !message)
}

function openAdminDialog() {
  if (state.mode === 'admin') return logoutAdmin()
  setAdminError('')
  el.adminDialog?.classList.remove('hidden')
  document.body.classList.add('dialog-open')
  setTimeout(() => el.adminUsername?.focus(), 20)
}

function closeAdminDialog() {
  el.adminDialog?.classList.add('hidden')
  document.body.classList.remove('dialog-open')
  if (el.adminPassword) el.adminPassword.value = ''
  setAdminError('')
}

function resetAdminTimer() {
  if (state.mode !== 'admin') return
  clearTimeout(state.adminTimer)
  const minutes = Number(state.adminConfig?.sessionTimeoutMinutes || 20)
  state.adminTimer = setTimeout(() => {
    logoutAdmin('Admin session ended after inactivity.')
  }, minutes * 60 * 1000)
}

function adminModeActive() {
  return state.mode === 'admin' && state.data?.manual?.mode === 'management'
}

async function loginAdmin(username, password) {
  const config = await loadAdminConfig()
  const now = Date.now()
  if (now < state.adminLockUntil) {
    const seconds = Math.ceil((state.adminLockUntil - now) / 1000)
    throw new Error(`Too many failed attempts. Try again in ${seconds} seconds.`)
  }
  if (String(username).trim().toLowerCase() !== String(config.username).trim().toLowerCase()) {
    throw new Error('Invalid admin username or password.')
  }
  const response = await fetch(config.encryptedDataFile, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Encrypted admin data returned HTTP ${response.status}`)
  const payload = await response.json()
  try {
    const managementData = await decryptAdminPayload(password, payload)
    if (!managementData?.jobDescriptions?.length || managementData.manual?.mode !== 'management') {
      throw new Error('Invalid management data.')
    }
    state.data = managementData
    state.mode = 'admin'
    state.adminFailures = 0
    document.documentElement.dataset.accessMode = 'admin'
    closeAdminDialog()
    resetAdminTimer()
    updateChrome()
    renderRoute()
    showToast('Confidential Admin View unlocked.')
  } catch (error) {
    state.adminFailures += 1
    const limit = Number(config.maxFailedAttempts || 5)
    if (state.adminFailures >= limit) {
      state.adminLockUntil = Date.now() + Number(config.lockoutSeconds || 60) * 1000
      state.adminFailures = 0
    }
    throw new Error('Invalid admin username or password.')
  }
}

function logoutAdmin(message = 'Admin View locked.') {
  clearTimeout(state.adminTimer)
  state.adminTimer = null
  state.mode = 'employee'
  state.data = state.employeeData
  document.documentElement.dataset.accessMode = 'employee'
  updateChrome()
  renderRoute()
  showToast(message)
}

async function loadPortalData() {
  if (window.MYEDEN_JD_DATA?.jobDescriptions?.length) return window.MYEDEN_JD_DATA

  const candidates = ['./data/employee-data.json', 'data/employee-data.json']
  let lastError
  for (const url of candidates) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
      const data = await response.json()
      if (!data?.jobDescriptions?.length) throw new Error(`${url} does not contain job descriptions`)
      return data
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`Unable to load the Job Description data. ${lastError?.message || ''}`.trim())
}

function toggleBookmark(reference) {
  const exists = state.bookmarks.includes(reference)
  state.bookmarks = exists ? state.bookmarks.filter((item) => item !== reference) : [...state.bookmarks, reference]
  writeJSON('bookmarks', state.bookmarks)
  renderRoute()
}

function toggleCompare(reference) {
  if (state.compare.includes(reference)) state.compare = state.compare.filter((item) => item !== reference)
  else state.compare = [...state.compare, reference].slice(-3)
  writeJSON('compare', state.compare)
  updateChrome()
  renderRoute()
}

function recordRecent(reference) {
  state.recent = [reference, ...state.recent.filter((item) => item !== reference)].slice(0, 8)
  writeJSON('recent', state.recent)
}

function parseRoute() {
  const raw = location.hash.slice(1) || '/'
  const [path, query = ''] = raw.split('?')
  return { path, params: new URLSearchParams(query) }
}

function updateChrome() {
  const data = state.data
  el.sidebarVersion.textContent = `Version ${data?.manual?.version || '2.0'}`
  if (el.modeBadge) {
    el.modeBadge.textContent = adminModeActive() ? 'Admin View' : 'Employee View'
    el.modeBadge.className = `mode-badge ${adminModeActive() ? 'admin' : 'employee'}`
  }
  if (el.adminButton) el.adminButton.textContent = adminModeActive() ? 'Sign Out' : 'Admin Login'
  if (state.compare.length) {
    el.compareButton.classList.remove('hidden')
    el.compareButton.textContent = `Compare (${state.compare.length})`
  } else {
    el.compareButton.classList.add('hidden')
  }
  renderDepartmentNav()
  updateActiveNav()
}

function renderDepartmentNav() {
  if (!state.data) return
  const counts = new Map()
  for (const jd of state.data.jobDescriptions) counts.set(jd.department, (counts.get(jd.department) || 0) + 1)
  el.departmentNav.innerHTML = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([department, count]) =>
    `<a href="#/?department=${encodeURIComponent(department)}"><span>${esc(department)}</span><small>${count}</small></a>`
  ).join('')
}

function updateActiveNav() {
  const { path } = parseRoute()
  document.querySelectorAll('#primary-nav a').forEach((link) => link.classList.remove('active'))
  const route = path.startsWith('/bookmarks') ? 'bookmarks' : path.startsWith('/compare') ? 'compare' : path.startsWith('/about') ? 'about' : 'home'
  document.querySelector(`#primary-nav a[data-route="${route}"]`)?.classList.add('active')
}

function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
}

function searchableText(jd) {
  return normalize([
    jd.reference, jd.department, jd.level, jd.jobTitle, jd.purpose,
    ...jd.responsibilities.flatMap((item) => [item.title, item.description]),
    ...jd.performanceExpectations,
    ...jd.coreCompetencies,
    ...jd.kpis.flatMap((item) => [item.area, item.measurementGuide]),
    jd.minimumQualifications, jd.requiredExperience, jd.workingConditions,
    ...jd.skillsAndKnowledge,
    ...(jd.salaryBand?.tiers || []).flatMap((item) => [item.tier, item.monthlySalaryRM, item.typicalProfile]),
    jd.salaryBand?.note || '',
  ].join(' '))
}

function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    for (let j = 0; j < curr.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

function searchScore(jd, query) {
  const q = normalize(query).trim()
  if (!q) return 1
  const title = normalize(jd.jobTitle)
  const ref = normalize(jd.reference)
  const dept = normalize(jd.department)
  const full = searchableText(jd)
  let score = 0
  if (ref === q) score += 1000
  if (title === q) score += 900
  if (title.startsWith(q)) score += 500
  if (ref.includes(q)) score += 450
  if (title.includes(q)) score += 400
  if (dept.includes(q)) score += 180
  if (full.includes(q)) score += 160
  const words = new Set(full.split(/[^a-z0-9]+/).filter(Boolean))
  for (const token of q.split(/\s+/).filter(Boolean)) {
    if (full.includes(token)) score += 50
    else if (token.length >= 4) {
      const threshold = token.length > 6 ? 2 : 1
      if ([...words].some((word) => Math.abs(word.length - token.length) <= threshold && levenshtein(word, token) <= threshold)) score += 20
      else return 0
    } else return 0
  }
  return score
}

function sortedJobs() {
  return [...(state.data?.jobDescriptions || [])].sort((a, b) => a.department.localeCompare(b.department) || a.level.localeCompare(b.level) || a.jobTitle.localeCompare(b.jobTitle))
}

function getFilteredJobs() {
  const query = state.directory.query
  const department = state.directory.department
  const level = state.directory.level
  return sortedJobs().map((jd) => ({ jd, score: searchScore(jd, query) }))
    .filter(({ jd, score }) => score > 0 && (!department || jd.department === department) && (!level || jd.level === level))
    .sort((a, b) => query ? b.score - a.score : 0)
    .map(({ jd }) => jd)
}

function jobLink(jd) {
  return `#/jd/${encodeURIComponent(jd.reference)}`
}

function renderDirectory(focusSearch = false) {
  const route = parseRoute()
  state.directory.department = route.params.get('department') || ''
  state.directory.level = route.params.get('level') || ''
  state.directory.query = route.params.get('q') || ''
  const jobs = sortedJobs()
  const results = getFilteredJobs()
  const departments = [...new Set(jobs.map((jd) => jd.department))]
  const levels = [...new Set(jobs.map((jd) => jd.level))].sort()
  const recentJobs = state.recent.map((ref) => jobs.find((jd) => jd.reference === ref)).filter(Boolean).slice(0, 4)
  const savedJobs = jobs.filter((jd) => state.bookmarks.includes(jd.reference)).slice(0, 4)

  el.page.innerHTML = `
    <div class="page-stack">
      <section class="hero-panel">
        <div><span class="eyebrow">PLATINUM EXPANDED EDITION v${esc(state.data.manual.version)}</span><h1>MYEDEN Job Description Manual</h1><p>Search, explore and compare ${state.data.manual.totalJobDescriptions} approved job descriptions across ${state.data.manual.totalDepartments} departments.</p></div>
        <div class="hero-stats"><div><strong>${state.data.manual.totalJobDescriptions}</strong><span>Job Descriptions</span></div><div><strong>${state.data.manual.totalDepartments}</strong><span>Departments</span></div><div><strong>5</strong><span>Career Levels</span></div></div>
      </section>
      <section class="search-panel">
        <label class="search-box"><span>⌕</span><input id="global-search" value="${attr(state.directory.query)}" placeholder="Search job title, reference, responsibility, KPI or skill…" /><button id="clear-search" type="button" aria-label="Clear search">×</button></label>
        <div class="filters">
          <label>☷ <select id="department-filter"><option value="">All departments</option>${departments.map((item) => `<option ${item === state.directory.department ? 'selected' : ''}>${esc(item)}</option>`).join('')}</select></label>
          <label><select id="level-filter"><option value="">All levels</option>${levels.map((item) => `<option ${item === state.directory.level ? 'selected' : ''}>${esc(item)}</option>`).join('')}</select></label>
          <button id="reset-filters" class="text-button" type="button">Clear filters</button>
        </div>
        <div class="example-searches"><small>Examples:</small> <button data-search-example="Content Creator">Content Creator</button><button data-search-example="L3 Childcare">L3 Childcare</button><button data-search-example="payroll compliance">payroll compliance</button></div>
      </section>
      ${adminModeActive() ? '<div class="access-notice admin-access"><span>⚠</span><div><strong>Confidential Admin View</strong><span>Salary-planning bands and internal controlled-document information are visible. Do not share or leave this view open on a shared device.</span></div></div>' : '<div class="access-notice"><span>🔒</span><div><strong>Employee View</strong><span>Salary bands are restricted. Select Admin Login to unlock the encrypted Management edition.</span></div></div>'}
      ${!state.directory.query && !state.directory.department && !state.directory.level && recentJobs.length ? renderCardSection('Recently viewed', recentJobs) : ''}
      ${!state.directory.query && !state.directory.department && !state.directory.level && savedJobs.length ? renderCardSection('Your bookmarks', savedJobs, '#/bookmarks') : ''}
      <section><div class="section-heading"><h2>Master Job Description Register</h2><span>${results.length} result${results.length === 1 ? '' : 's'}</span></div>
      ${results.length ? `<div class="register-table-wrap"><table class="register-table"><thead><tr><th>Reference</th><th>Department</th><th>Level</th><th>Job Title</th><th>Page</th></tr></thead><tbody>${results.map(renderRegisterRow).join('')}</tbody></table></div>` : '<div class="empty-search"><span>⌕</span><h3>No matching job descriptions</h3><p>Try a job title, document reference, responsibility, KPI or broader keyword.</p></div>'}
      </section>
    </div>`

  const searchInput = document.querySelector('#global-search')
  let searchTimer
  searchInput?.addEventListener('input', (event) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      state.directory.query = event.target.value
      updateDirectoryHash()
      renderDirectory(true)
    }, 140)
  })
  document.querySelector('#clear-search')?.addEventListener('click', () => { state.directory.query = ''; updateDirectoryHash(); renderDirectory() })
  document.querySelector('#department-filter')?.addEventListener('change', (event) => { state.directory.department = event.target.value; updateDirectoryHash(); renderDirectory() })
  document.querySelector('#level-filter')?.addEventListener('change', (event) => { state.directory.level = event.target.value; updateDirectoryHash(); renderDirectory() })
  document.querySelector('#reset-filters')?.addEventListener('click', () => { state.directory = { query: '', department: '', level: '' }; location.hash = '#/' })
  document.querySelectorAll('[data-search-example]').forEach((button) => button.addEventListener('click', () => { state.directory.query = button.dataset.searchExample; updateDirectoryHash(); renderDirectory() }))
  bindCommonActions()
  if (focusSearch) {
    const refreshed = document.querySelector('#global-search')
    if (refreshed) {
      refreshed.focus()
      const end = refreshed.value.length
      refreshed.setSelectionRange(end, end)
    }
  }
}

function updateDirectoryHash() {
  const params = new URLSearchParams()
  if (state.directory.query) params.set('q', state.directory.query)
  if (state.directory.department) params.set('department', state.directory.department)
  if (state.directory.level) params.set('level', state.directory.level)
  history.replaceState(null, '', `#/${params.toString() ? `?${params}` : ''}`)
}

function renderRegisterRow(jd) {
  return `<tr><td><code>${esc(jd.reference)}</code></td><td>${esc(jd.department)}</td><td><span class="level-pill">${esc(jd.level)}</span></td><td><a href="${jobLink(jd)}">${esc(jd.jobTitle)}</a></td><td>${jd.originalPage || '—'}</td></tr>`
}

function renderCardSection(title, jobs, link = '') {
  return `<section><div class="section-heading"><h2>${esc(title)}</h2>${link ? `<a href="${link}">View all</a>` : ''}</div><div class="card-grid compact-grid">${jobs.map((jd) => renderJobCard(jd, true)).join('')}</div></section>`
}

function renderJobCard(jd, compact = false) {
  const saved = state.bookmarks.includes(jd.reference)
  const compared = state.compare.includes(jd.reference)
  return `<article class="job-card ${compact ? 'compact' : ''}"><div class="job-card-meta"><span>${esc(jd.level)}</span><span>${esc(jd.department)}</span></div><h3><a href="${jobLink(jd)}">${esc(jd.jobTitle)}</a></h3><p>${esc(jd.purpose)}</p><div class="job-card-footer"><code>${esc(jd.reference)}</code><div class="route-card-actions"><button class="icon-button ${saved ? 'active' : ''}" data-action="bookmark" data-reference="${attr(jd.reference)}" type="button" aria-label="Bookmark">${saved ? '★' : '☆'}</button><button class="icon-button ${compared ? 'active' : ''}" data-action="compare" data-reference="${attr(jd.reference)}" type="button" aria-label="Compare">▥</button></div></div></article>`
}

function renderJobDetail(reference) {
  const jobs = sortedJobs()
  const jd = jobs.find((item) => item.reference === decodeURIComponent(reference))
  if (!jd) return renderEmpty('Job description not found', 'The requested reference is not available in this digital edition.')
  recordRecent(jd.reference)
  const index = jobs.findIndex((item) => item.reference === jd.reference)
  const previous = jobs[index - 1]
  const next = jobs[index + 1]
  const saved = state.bookmarks.includes(jd.reference)
  const compared = state.compare.includes(jd.reference)

  el.page.innerHTML = `<article class="job-detail">
    <div class="detail-hero"><div class="detail-breadcrumb"><a href="#/">Master Register</a><span>/</span><a href="#/?department=${encodeURIComponent(jd.department)}">${esc(jd.department)}</a><span>/</span><strong>${esc(jd.level)}</strong></div>
      <div class="detail-title-row"><div><div class="detail-kickers"><span>${esc(jd.level)}</span><span>${esc(jd.department)}</span><code>${esc(jd.reference)}</code></div><h1>${esc(jd.jobTitle)}</h1><p>${esc(jd.purpose)}</p></div>
      <div class="detail-actions no-print"><button data-action="bookmark" data-reference="${attr(jd.reference)}" type="button">${saved ? '★ Saved' : '☆ Bookmark'}</button><button class="${compared ? 'selected' : ''}" data-action="compare" data-reference="${attr(jd.reference)}" type="button">▥ ${compared ? 'In comparison' : 'Compare'}</button><button data-action="print" type="button">⎙ Print</button><button data-action="copy-link" type="button">⌁ Copy link</button></div></div></div>
    <nav class="section-jump no-print"><a href="#summary">Summary</a><a href="#responsibilities">Responsibilities</a><a href="#performance">Performance</a><a href="#kpis">KPIs</a><a href="#requirements">Requirements</a>${adminModeActive() && jd.salaryBand ? '<a href="#salary">Salary Band</a>' : ''}<a href="#career">Career Path</a></nav>
    ${section('summary', 'Position Summary', renderSummary(jd), true)}
    ${section('responsibilities', 'Key Responsibilities', renderResponsibilities(jd), true)}
    ${section('performance', 'Performance Expectations', `<ul class="check-list">${jd.performanceExpectations.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`)}
    ${section('competencies', 'Core Competencies and Skills', `<div class="tag-cloud">${jd.coreCompetencies.map((item) => `<span>${esc(item)}</span>`).join('')}</div><h4 class="subheading">Skills and Knowledge</h4><div class="tag-cloud secondary">${jd.skillsAndKnowledge.map((item) => `<span>${esc(item)}</span>`).join('')}</div>`)}
    ${section('loves', 'L.O.V.E.S. Core Values Alignment', renderLoves(jd))}
    ${section('kpis', 'Key Performance Indicators', renderKpis(jd))}
    ${section('requirements', 'Qualifications, Experience and Working Conditions', `<div class="requirements-grid"><div><h4>Minimum Qualifications</h4><p>${esc(jd.minimumQualifications)}</p></div><div><h4>Required Experience</h4><p>${esc(jd.requiredExperience)}</p></div><div><h4>Working Conditions</h4><p>${esc(jd.workingConditions)}</p></div></div>`)}
    ${adminModeActive() && jd.salaryBand ? section('salary', `Salary Planning Band — ${jd.jobTitle}`, renderSalaryBand(jd), true) : '<div class="locked-admin-section no-print"><span>🔒</span><div><strong>Salary Planning Band</strong><p>Available only after authorised Admin Login.</p></div><button data-action="admin-login" type="button">Admin Login</button></div>'}
    ${adminModeActive() && jd.employeeAcknowledgementFields?.length ? section('acknowledgement', 'Employee Acknowledgement Fields', `<div class="acknowledgement-grid">${jd.employeeAcknowledgementFields.map((item) => `<div><span>${esc(item)}</span><hr /></div>`).join('')}</div>`) : ''}
    ${section('career', `Career Path — ${jd.department}`, `${renderCareerPath(jd, jobs)}<div class="career-notes"><div><h4>Promotion Readiness</h4><ul>${jd.promotionReadiness.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div><div><h4>Career Progression Note</h4><p>${esc(jd.careerProgressionNote)}</p></div></div>`, true)}
    <div class="prev-next no-print">${previous ? `<a href="${jobLink(previous)}"><span>‹</span><span><small>Previous</small>${esc(previous.jobTitle)}</span></a>` : '<span></span>'}${next ? `<a href="${jobLink(next)}"><span><small>Next</small>${esc(next.jobTitle)}</span><span>›</span></a>` : '<span></span>'}</div>
  </article>`
  bindCommonActions()
}

function section(id, title, body, open = false) {
  return `<details class="content-section" id="${attr(id)}" ${open ? 'open' : ''}><summary><span>${esc(title)}</span><span class="summary-chevron">›</span></summary><div class="section-body">${body}</div></details>`
}

function renderSummary(jd) {
  const items = [
    ['Reports To', jd.positionSummary.reportsTo], ['Direct Reports', jd.positionSummary.directReports], ['Location', jd.positionSummary.location], ['Employment Type', jd.positionSummary.employmentType], ['Works Closely With', jd.positionSummary.worksCloselyWith], ['Original Manual Page', jd.originalPage || '—'],
  ]
  return `<div class="summary-grid">${items.map(([label, value]) => `<div><small>${esc(label)}</small><span>${esc(value || '—')}</span></div>`).join('')}</div>`
}

function renderResponsibilities(jd) {
  return `<div class="responsibility-list">${jd.responsibilities.map((item) => `<div><span>${item.number}</span><div><h4>${esc(item.title)}</h4><p>${esc(item.description)}</p></div></div>`).join('')}</div>`
}

function renderLoves(jd) {
  return `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Value</th><th>Behavioural Expectation</th></tr></thead><tbody>${jd.lovesAlignment.map((item) => `<tr><td><strong>${esc(item.name)}</strong></td><td>${esc(item.description)}</td></tr>`).join('')}</tbody></table></div>`
}

function renderKpis(jd) {
  return `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>KPI Area</th><th>Measurement Guide</th></tr></thead><tbody>${jd.kpis.map((item) => `<tr><td>${esc(item.area)}</td><td>${esc(item.measurementGuide)}</td></tr>`).join('')}</tbody></table></div>`
}


function renderSalaryBand(jd) {
  const band = jd.salaryBand
  if (!band) return '<p>No salary-planning band is recorded for this position.</p>'
  return `<div class="confidential-banner"><strong>CONFIDENTIAL — INTERNAL PLANNING ONLY</strong><span>${esc(band.note || '')}</span></div><div class="data-table-wrap"><table class="data-table salary-table"><thead><tr><th>Tier</th><th>Monthly Salary (RM)</th><th>Typical Profile</th></tr></thead><tbody>${(band.tiers || []).map((item) => `<tr><td><strong>${esc(item.tier)}</strong></td><td>${esc(item.monthlySalaryRM)}</td><td>${esc(item.typicalProfile)}</td></tr>`).join('')}</tbody></table></div>`
}


function renderCareerPath(jd, jobs) {
  return `<div class="career-path">${jd.careerPath.map((step, index) => {
    const linked = jobs.find((candidate) => candidate.department === jd.department && candidate.level === step.level)
    const current = step.level === jd.level ? 'current' : ''
    const content = `<small>${esc(step.level)}</small><strong>${esc(step.jobTitle)}</strong>`
    return `${linked ? `<a class="${current}" href="${jobLink(linked)}">${content}</a>` : `<div class="${current}">${content}</div>`}${index < jd.careerPath.length - 1 ? '<span class="career-arrow">›</span>' : ''}`
  }).join('')}</div>`
}

function renderBookmarks() {
  const jobs = sortedJobs().filter((jd) => state.bookmarks.includes(jd.reference))
  if (!jobs.length) return renderEmpty('No bookmarks yet', 'Save job descriptions to create your personal quick-reference library.')
  el.page.innerHTML = `<div class="page-stack">${pageHeading('Bookmarked Job Descriptions', `${jobs.length} saved position${jobs.length === 1 ? '' : 's'}`)}<div class="card-grid">${jobs.map((jd) => renderJobCard(jd)).join('')}</div></div>`
  bindCommonActions()
}

function renderCompare() {
  const jobs = state.compare.map((ref) => state.data.jobDescriptions.find((jd) => jd.reference === ref)).filter(Boolean)
  if (jobs.length < 2) return renderEmpty('Select at least two positions', 'Use the Compare button on a job card or job-description page. You may compare up to three positions.')
  const rows = [
    ['Purpose', (jd) => jd.purpose], ['Reports To', (jd) => jd.positionSummary.reportsTo], ['Direct Reports', (jd) => jd.positionSummary.directReports], ['Experience', (jd) => jd.requiredExperience], ['Qualifications', (jd) => jd.minimumQualifications], ['Core Competencies', (jd) => jd.coreCompetencies.join(' • ')], ['Key Responsibilities', (jd) => jd.responsibilities.map((item) => item.title).join(' • ')], ['KPI Areas', (jd) => jd.kpis.map((item) => item.area).join(' • ')], ['Promotion Readiness', (jd) => jd.promotionReadiness.join(' • ')],
    ...(adminModeActive() ? [['Salary Planning Band', (jd) => (jd.salaryBand?.tiers || []).map((item) => `${item.tier}: RM ${item.monthlySalaryRM}`).join(' • ') || '—']] : []),
  ]
  el.page.innerHTML = `<div class="page-stack">${pageHeading('Compare Career Levels', 'Review accountability, requirements and progression side by side.')}<div class="compare-wrap"><table class="compare-table"><thead><tr><th>Area</th>${jobs.map((jd) => `<th><span>${esc(jd.level)}</span><a href="${jobLink(jd)}">${esc(jd.jobTitle)}</a><button data-action="compare" data-reference="${attr(jd.reference)}" type="button">Remove</button></th>`).join('')}</tr></thead><tbody>${rows.map(([label, getter]) => `<tr><th>${esc(label)}</th>${jobs.map((jd) => `<td>${esc(getter(jd))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`
  bindCommonActions()
}

function renderAbout() {
  const manual = state.data.manual
  el.page.innerHTML = `<div class="page-stack">${pageHeading('About This Digital Manual', 'Controlled-document information and career framework.')}<section class="info-card"><h2>Document Information</h2><dl><div><dt>Document Reference</dt><dd>${esc(manual.documentReference)}</dd></div><div><dt>Version</dt><dd>${esc(manual.version)}</dd></div><div><dt>Status</dt><dd>${esc(manual.documentStatus)}</dd></div><div><dt>Effective Date</dt><dd>${esc(manual.effectiveDate)}</dd></div><div><dt>Review Cycle</dt><dd>${esc(manual.reviewCycle)}</dd></div><div><dt>Digital Edition</dt><dd>${adminModeActive() ? 'Encrypted Static Admin PWA' : 'Static Employee PWA'}</dd></div></dl></section>${adminModeActive() && manual.documentControl?.['Approval and Review'] ? `<section class="info-card"><h2>Approval and Review</h2><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Control Item</th><th>Responsible Party</th><th>Date</th><th>Signature</th></tr></thead><tbody>${manual.documentControl['Approval and Review'].map((item) => `<tr><td>${esc(item.controlItem)}</td><td>${esc(item.responsibleParty)}</td><td>${esc(item.date || '—')}</td><td>${esc(item.signature || '—')}</td></tr>`).join('')}</tbody></table></div></section>` : ''}<section class="info-card"><h2>MYEDEN Career Framework</h2><div class="framework-grid">${state.data.framework.levels.map((item) => `<div><span>${esc(item.level)}</span><h3>${esc(item.careerStage)}</h3><p>${esc(item.primaryAccountability)}</p><small>${esc(item.progressionStandard)}</small></div>`).join('')}</div></section></div>`
}

function pageHeading(title, subtitle) {
  return `<div class="page-heading"><div><span class="eyebrow">MYEDEN GROUP SDN. BHD.</span><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><span class="page-heading-icon">▤</span></div>`
}

function renderEmpty(title, text) {
  el.page.innerHTML = `<div class="empty-state"><span>▤</span><h2>${esc(title)}</h2><p>${esc(text)}</p><a class="primary-link" href="#/">Browse the Master Register</a></div>`
}

function bindCommonActions() {
  document.querySelectorAll('[data-action="bookmark"]').forEach((button) => button.addEventListener('click', () => toggleBookmark(button.dataset.reference)))
  document.querySelectorAll('[data-action="compare"]').forEach((button) => button.addEventListener('click', () => toggleCompare(button.dataset.reference)))
  document.querySelectorAll('[data-action="admin-login"]').forEach((button) => button.addEventListener('click', openAdminDialog))
  document.querySelectorAll('[data-action="print"]').forEach((button) => button.addEventListener('click', () => window.print()))
  document.querySelectorAll('[data-action="copy-link"]').forEach((button) => button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(location.href)
    showToast('Link copied.')
  }))
}

function renderRoute() {
  if (!state.data) return
  updateChrome()
  const { path } = parseRoute()
  if (path === '/' || path === '') renderDirectory()
  else if (path.startsWith('/jd/')) renderJobDetail(path.slice('/jd/'.length))
  else if (path === '/bookmarks') renderBookmarks()
  else if (path === '/compare') renderCompare()
  else if (path === '/about') renderAbout()
  else location.hash = '#/'
  el.page.closest('main')?.focus({ preventScroll: true })
  window.scrollTo({ top: 0, behavior: 'auto' })
  closeSidebar()
}

function openSidebar() {
  el.sidebar.classList.add('open')
  el.sidebarScrim.classList.remove('hidden')
}

function closeSidebar() {
  el.sidebar.classList.remove('open')
  el.sidebarScrim.classList.add('hidden')
}

async function initialise() {
  applyTheme()
  setLoading(true)
  try {
    state.data = await loadPortalData()
    state.employeeData = state.data
    state.mode = 'employee'
    document.documentElement.dataset.accessMode = 'employee'
    updateChrome()
    renderRoute()
  } catch (error) {
    showError(error.message)
    el.page.innerHTML = '<div class="empty-state"><h2>Unable to start the portal</h2><p>Confirm that data/employee-data.json is present and reload the page.</p></div>'
  } finally {
    setLoading(false)
  }
}

window.addEventListener('hashchange', renderRoute)
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  state.installPrompt = event
  el.installButton.classList.remove('hidden')
})
window.addEventListener('appinstalled', () => {
  state.installPrompt = null
  el.installButton.classList.add('hidden')
  showToast('MYEDEN JD Portal installed.')
})

el.installButton.addEventListener('click', async () => {
  if (!state.installPrompt) return
  state.installPrompt.prompt()
  await state.installPrompt.userChoice
  state.installPrompt = null
  el.installButton.classList.add('hidden')
})
el.themeButton.addEventListener('click', () => { state.theme = state.theme === 'light' ? 'dark' : 'light'; applyTheme() })
el.compareButton.addEventListener('click', () => { location.hash = '#/compare' })

el.adminButton?.addEventListener('click', openAdminDialog)
el.adminDialogClose?.addEventListener('click', closeAdminDialog)
el.adminDialog?.addEventListener('click', (event) => { if (event.target === el.adminDialog) closeAdminDialog() })
el.showAdminPassword?.addEventListener('change', () => { if (el.adminPassword) el.adminPassword.type = el.showAdminPassword.checked ? 'text' : 'password' })
el.adminLoginForm?.addEventListener('submit', async (event) => {
  event.preventDefault()
  setAdminError('')
  el.adminLoginSubmit.disabled = true
  el.adminLoginSubmit.textContent = 'Unlocking…'
  try {
    await loginAdmin(el.adminUsername.value, el.adminPassword.value)
  } catch (error) {
    setAdminError(error.message)
  } finally {
    el.adminLoginSubmit.disabled = false
    el.adminLoginSubmit.textContent = 'Unlock Admin View'
    if (el.adminPassword) el.adminPassword.value = ''
  }
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.adminDialog?.classList.contains('hidden')) closeAdminDialog()
  if (adminModeActive()) resetAdminTimer()
})
for (const eventName of ['click', 'mousemove', 'touchstart']) {
  document.addEventListener(eventName, () => { if (adminModeActive()) resetAdminTimer() }, { passive: true })
}

document.querySelector('#mobile-menu-button').addEventListener('click', openSidebar)
document.querySelector('#sidebar-close').addEventListener('click', closeSidebar)
el.sidebarScrim.addEventListener('click', closeSidebar)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js').catch(() => {}))
}

initialise()
