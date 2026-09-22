// Every data-qa / css candidate the hh flows rely on, in one place. NONE of these are verified
// against live hh markup yet: they come from memory of hh.ru pages and must be checked against
// recordings made with `sgz hh-record`. Arrays are tried in order; the first existing one wins.

export const SEL = {
  login: {
    form: ['[data-qa="account-login-form"]', 'form[action*="/account/login"]', '[data-qa="login-form"]'],
    loggedInMarker: ['[data-qa="mainmenu_applicantProfile"]', '[data-qa="mainmenu_myResumes"]', '[data-qa="header-account"]'],
  },
  block: {
    captchaMarker: ['[data-qa="captcha"]', 'form[action*="captcha"]', 'iframe[src*="captcha"]'],
  },
  search: {
    item: '[data-qa="vacancy-serp__vacancy"]',
    title: '[data-qa="serp-item__title"], a[data-qa="vacancy-serp__vacancy-title"]',
    company: '[data-qa="vacancy-serp__vacancy-employer"]',
    salary: '[data-qa="vacancy-serp__vacancy-compensation"]',
  },
  vacancy: {
    title: '[data-qa="vacancy-title"]',
    company: '[data-qa="vacancy-company-name"]',
    salary: '[data-qa="vacancy-salary"]',
    description: '[data-qa="vacancy-description"]',
    area: '[data-qa="vacancy-view-location"], [data-qa="vacancy-view-raw-address"]',
    respondTop: '[data-qa="vacancy-response-link-top"]',
    respondAny: '[data-qa^="vacancy-response-link"]',
    alreadyApplied: '[data-qa="vacancy-response-link-view-topic"]',
    archivedMarker: '[data-qa="vacancy-archived"], .vacancy-archive-info',
    testMarker: '[data-qa="vacancy-response-link-test"]',
  },
  apply: {
    popup: ['[data-qa="vacancy-response-popup"]', '[data-qa="bloko-modal"]', '[role="dialog"]'],
    otherCountryPopup: ['[data-qa="relocation-warning-confirm"]', '[data-qa="relocation-warning"]'],
    otherCountryConfirm: '[data-qa="relocation-warning-confirm"]',
    resumeChooser: ['[data-qa="resume-select-radio"]', '[data-qa="vacancy-response-popup-resume"]', 'input[name="resume"]'],
    letterToggle: ['[data-qa="vacancy-response-letter-toggle"]', '[data-qa="add-cover-letter"]'],
    letterTextarea: ['[data-qa="vacancy-response-popup-form-letter-input"]', 'textarea[name="letter"]', 'textarea[data-qa="vacancy-response-letter"]'],
    questionnaire: ['[data-qa="vacancy-response-questions"]', '[data-qa="task-body"]', 'form[data-qa="vacancy-response-form"] fieldset'],
    submit: ['[data-qa="vacancy-response-submit-popup"]', '[data-qa="vacancy-response-letter-submit"]', 'button[type="submit"][data-qa*="response"]'],
    success: ['[data-qa="vacancy-response-link-view-topic"]', '[data-qa="vacancy-response-success"]'],
  },
  resumes: {
    card: '[data-qa="resume"]',
    titleLink: '[data-qa="resume-title-link"]',
    menu: ['[data-qa="resume-actions-menu"]', '[data-qa="resume-more-actions"]'],
    duplicate: ['[data-qa="resume-duplicate"]', '[data-qa="resume-action-duplicate"]'],
    touchButton: ['[data-qa="resume-update-button"]', '[data-qa="resume-update-button_actions"]', 'button[data-qa="resume-update"]'],
  },
  negotiations: {
    item: '[data-qa="negotiations-item"]',
    unread: '[data-qa="negotiations-item-unread"]',
    chatLink: 'a[href*="chatik.hh.ru"], a[data-qa="negotiations-item-chat"]',
  },
  chat: {
    input: ['[data-qa="chatik-new-message-text"]', 'textarea[data-qa="chat-input"]', '[contenteditable="true"][data-qa*="message"]'],
    send: ['[data-qa="chatik-send-message-button"]', 'button[data-qa="chat-send"]'],
    message: '[data-qa="chatik-chat-message"]',
    survey: ['[data-qa="chatik-survey"]', '[data-qa="chat-survey"]'],
  },
} as const;

/** Texts hh shows on success / block screens. Substring matches, case-sensitive Russian. */
export const TEXT = {
  applySuccess: ["Резюме доставлено", "Отклик отправлен", "Отклик доставлен"],
  alreadyApplied: ["Вы откликнулись", "Отклик уже отправлен"],
  otherCountry: ["Всё равно откликнуться", "в другой стране"],
  otherCountryConfirm: "Всё равно откликнуться",
  respond: "Откликнуться",
  letterToggle: "Сопроводительное письмо",
  captcha: ["Подтвердите, что вы не робот", "Введите символы с картинки", "captcha"],
  antiBot: ["подозрительная активность", "Доступ ограничен", "Access denied", "403 Forbidden"],
  archived: ["Вакансия в архиве", "вакансия находится в архиве", "Вакансия закрыта"],
  capacity: /Вы можете создать ещ[её] (\d+) резюме/u,
  touch: "Поднять в поиске",
} as const;
