/* Questions asked from the explorer's "Ask it something" tab that the canned
 * list does not answer. Anyone signed in may ask one; only a super user may
 * answer it, the same layer that already holds the register and the disease
 * list.
 */
import { sql, run, raw } from './db.js';

const COLS = `QuestionId, AskedByUserId, AskedByName, QuestionText, Status,
  AnswerText, AnsweredByUserId, AnsweredByName, AnsweredAt, CreatedAt`;

function shape(r) {
  return {
    questionId: Number(r.QuestionId),
    askedByUserId: Number(r.AskedByUserId),
    askedByName: r.AskedByName,
    text: r.QuestionText,
    status: r.Status,
    answer: r.AnswerText || null,
    answeredByName: r.AnsweredByName || null,
    answeredAt: r.AnsweredAt || null,
    createdAt: r.CreatedAt,
  };
}

function questionProblems(text) {
  const s = String(text || '').trim();
  const out = [];
  if (!s) out.push('a question cannot be blank');
  if (s.length > 2000) out.push('a question must be under 2000 characters');
  return out;
}

export async function questionById(id) {
  const rows = await sql`SELECT ${raw(COLS)} FROM arms.Question WHERE QuestionId = ${Number(id)}`;
  return rows[0] ? shape(rows[0]) : null;
}

export async function askQuestion({ user, text }) {
  const problems = questionProblems(text);
  if (problems.length) throw new Error(problems.join('; '));

  const clean = String(text).trim();
  const { insertId } = await run`
INSERT INTO arms.Question (AskedByUserId, AskedByName, QuestionText)
VALUES (${user.userId}, ${user.fullName}, ${clean})`;

  return questionById(insertId);
}

export async function myQuestions(userId) {
  const rows = await sql`SELECT ${raw(COLS)} FROM arms.Question
    WHERE AskedByUserId = ${Number(userId)} ORDER BY CreatedAt DESC`;
  return rows.map(shape);
}

export async function listQuestions() {
  const rows = await sql`SELECT ${raw(COLS)} FROM arms.Question
    ORDER BY (Status = 'open') DESC, CreatedAt DESC`;
  return rows.map(shape);
}

export async function countOpenQuestions() {
  const [row] = await sql`SELECT COUNT(*) AS n FROM arms.Question WHERE Status = 'open'`;
  return Number(row?.n || 0);
}

export async function answerQuestion({ id, answer, admin }) {
  const clean = String(answer || '').trim();
  if (!clean) throw new Error('an answer cannot be blank');

  await sql`UPDATE arms.Question
    SET AnswerText = ${clean}, AnsweredByUserId = ${admin.userId},
        AnsweredByName = ${admin.fullName}, AnsweredAt = UTC_TIMESTAMP(), Status = 'answered'
    WHERE QuestionId = ${Number(id)}`;

  return questionById(id);
}
