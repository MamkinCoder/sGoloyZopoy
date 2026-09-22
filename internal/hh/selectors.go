package hh

// Selectors is the single place where hh.ru markup knowledge lives. Values are CANDIDATES to be
// verified against recordings (sgz hh-record); when hh changes markup this is the file to fix.
// Owned by workstream B; workstream C may ADD fields for chats/resumes but not rename existing ones.
type Selectors struct {
	// search results
	SearchCard     string // a[data-qa="serp-item__title"]
	SearchCardRoot string // [data-qa="vacancy-serp__vacancy"]
	SearchEmpty    string // [data-qa="vacancy-serp__no-results"] or text «ничего не найдено»
	// vacancy page
	VacancyTitle       string // [data-qa="vacancy-title"]
	VacancyCompany     string // [data-qa="vacancy-company-name"]
	VacancySalary      string // [data-qa="vacancy-salary"]
	VacancyDescription string // [data-qa="vacancy-description"]
	VacancyKeySkills   string // [data-qa="bloko-tag__text"] under skills
	ApplyButtonTop     string // [data-qa="vacancy-response-link-top"]
	AppliedMarker      string // [data-qa="vacancy-response-link-view-topic"] («Вы откликнулись»)
	TestBadge          string // text «тестовое задание» / «Откликнуться и пройти тест»
	ArchivedMarker     string // [data-qa="vacancy-archived"] / text «Вакансия в архиве»
	// apply popup
	OtherCountryConfirm string // [data-qa="relocation-warning-confirm"] («Всё равно откликнуться»)
	ResumeOption        string // [data-qa="resume-select"] / label containing resume title
	LetterToggle        string // [data-qa="vacancy-response-letter-toggle"] («Сопроводительное письмо»)
	LetterInput         string // [data-qa="vacancy-response-popup-form-letter-input"] textarea
	ApplySubmit         string // [data-qa="vacancy-response-submit-popup"]
	PopupRoot           string // [data-qa="vacancy-response-popup"] / [role=dialog]
	QuestionnaireRoot   string // form inside popup with questions
	SuccessText         string // «Резюме доставлено» | «Отклик отправлен»
	// session / anti-bot
	LoginFormMarker string // [data-qa="account-login-form"] or URL /account/login
	CaptchaMarker   string // [data-qa="captcha"] / iframe[src*="captcha"] / text «Подтвердите, что вы не робот»
	SuspiciousText  string // «подозрительная активность»
	// chats (workstream C)
	NegotiationsList  string // [data-qa="negotiations-item"]
	NegotiationUnread string // [data-qa="negotiations-item-unread"]
	ChatMessage       string // [data-qa="chat-message"]
	ChatInput         string // [data-qa="chat-input"] / textarea
	ChatSend          string // [data-qa="chat-send"]
	ChatSurveyRoot    string // bot survey widget root
	// resumes (workstream C)
	ResumeCard        string // [data-qa="resume"] on /applicant/resumes
	ResumeTitleLink   string // [data-qa="resume-title-link"]
	ResumeTouchButton string // [data-qa="resume-update-button"] («Поднять в поиске»)
	ResumeMenuButton  string // [data-qa="resume-actions-menu"]
	ResumeDuplicate   string // menu item «Дублировать»
	ResumeCreateLimit string // text «Вы можете создать ещё N резюме»
}

// DefaultSelectors returns the current best-known values. Keep in sync with recordings.
func DefaultSelectors() Selectors {
	return Selectors{
		SearchCard:          `a[data-qa="serp-item__title"]`,
		SearchCardRoot:      `[data-qa="vacancy-serp__vacancy"]`,
		SearchEmpty:         `[data-qa="vacancy-serp__no-results"]`,
		VacancyTitle:        `[data-qa="vacancy-title"]`,
		VacancyCompany:      `[data-qa="vacancy-company-name"]`,
		VacancySalary:       `[data-qa="vacancy-salary"]`,
		VacancyDescription:  `[data-qa="vacancy-description"]`,
		VacancyKeySkills:    `[data-qa="skills-element"]`,
		ApplyButtonTop:      `[data-qa="vacancy-response-link-top"]`,
		AppliedMarker:       `[data-qa="vacancy-response-link-view-topic"]`,
		TestBadge:           `тестовое задание`,
		ArchivedMarker:      `[data-qa="vacancy-archived"]`,
		OtherCountryConfirm: `[data-qa="relocation-warning-confirm"]`,
		ResumeOption:        `[data-qa="resume-select"]`,
		LetterToggle:        `[data-qa="vacancy-response-letter-toggle"]`,
		LetterInput:         `[data-qa="vacancy-response-popup-form-letter-input"]`,
		ApplySubmit:         `[data-qa="vacancy-response-submit-popup"]`,
		PopupRoot:           `[data-qa="vacancy-response-popup"]`,
		QuestionnaireRoot:   `[data-qa="vacancy-response-popup"] form`,
		SuccessText:         `Резюме доставлено`,
		LoginFormMarker:     `[data-qa="account-login-form"]`,
		CaptchaMarker:       `[data-qa="captcha"]`,
		SuspiciousText:      `подозрительная активность`,
		NegotiationsList:    `[data-qa="negotiations-item"]`,
		NegotiationUnread:   `[data-qa="negotiations-item-unread"]`,
		ChatMessage:         `[data-qa="chat-message"]`,
		ChatInput:           `[data-qa="chat-input"]`,
		ChatSend:            `[data-qa="chat-send"]`,
		ChatSurveyRoot:      `[data-qa="chat-survey"]`,
		ResumeCard:          `[data-qa="resume"]`,
		ResumeTitleLink:     `[data-qa="resume-title-link"]`,
		ResumeTouchButton:   `[data-qa="resume-update-button"]`,
		ResumeMenuButton:    `[data-qa="resume-actions-menu"]`,
		ResumeDuplicate:     `Дублировать`,
		ResumeCreateLimit:   `Вы можете создать ещё`,
	}
}
