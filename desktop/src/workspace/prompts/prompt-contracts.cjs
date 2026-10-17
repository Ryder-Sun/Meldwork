// Instructions every Agent prompt shares: how to answer, and what a delivered
// file means. They are plain functions of the conversation so each prompt
// builder can include exactly the parts it needs.

function responseLanguageFromText(text) {
  const source = String(text || '').normalize('NFKC')
  const han = (source.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length
  const kana = (source.match(/[\u3040-\u30ff]/g) || []).length
  const hangul = (source.match(/[\uac00-\ud7af]/g) || []).length
  const cyrillic = (source.match(/[\u0400-\u052f]/g) || []).length
  const arabic = (source.match(/[\u0600-\u06ff]/g) || []).length
  const latin = (source.match(/[A-Za-z]/g) || []).length

  if (kana > 0) return 'Japanese'
  if (hangul > 0) return 'Korean'
  if (cyrillic > 0) return 'Russian'
  if (arabic > 0) return 'Arabic'
  if (han > 0 && (latin === 0 || han >= latin)) return 'Chinese'
  if (latin > 0) return 'English'
  return ''
}

function responseLanguagePrompt(language = '') {
  const classification = language
    ? `The latest user message is written primarily in ${language}.`
    : 'The latest user message language was not confidently classified; infer it from the message body only.'
  return [
    'Response language contract:',
    'Always answer entirely in the language of the latest user message unless that message explicitly requests another language.',
    classification,
    'If the latest user message is English, answer entirely in English. If it is Chinese, answer entirely in Chinese.',
    'Do not infer response language from the app UI locale, operating-system locale, Agent name, attachment filenames, or earlier conversation turns.',
    'Do not translate or switch languages unless the latest user message explicitly asks for it.',
  ].join('\n')
}

function deliveryContract(group) {
  return group?.allowWrite
    ? [
        'Workspace access: You may create and edit files in the conversation working directory. When the user requests a deliverable, execute the work instead of returning only a plan.',
        'Deliverable capture contract: Save or copy each final document, code file, diff, structured-data file, media file, or bundle into .meldwork-output/ in the conversation working directory.',
        'Only files created or changed during this run are captured as durable outputs. Do not claim a deliverable exists until the real file has been written there.',
        'When the user asks for an image, audio, or video, do not claim it was generated unless a real file exists.',
        'Supported chat attachments include common images, media, documents, source code, configuration text, and archives. Other recognized outputs remain durable Artifacts.',
      ].join('\n')
    : [
        'This conversation is read-only. Do not claim that a media file was generated or delivered because no writable output can be attached.',
        'If the user requests generated media, explain that workspace write access must be enabled before a real file can be delivered.',
      ].join('\n')
}

module.exports = { deliveryContract, responseLanguageFromText, responseLanguagePrompt }
