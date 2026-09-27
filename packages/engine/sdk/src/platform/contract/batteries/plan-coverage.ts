/**
 * `contract.plan-coverage` (docs/design/contract-runner.md section 3.4): does
 * the plan's list of contract criteria leave out anything the user stated?
 * One question about `{ request, criteria }`, asked once per plan.
 *
 * Band: a missed requirement is work the contract would pass without doing,
 * so "nothing is missing" is read at high stakes and only a no at act clears
 * the plan; a yes at any outcome sends the planner a repair.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

export const planCoverage = defineBattery({
  name: 'contract.plan-coverage',
  version: 1,
  description: "Whether the user's request states a requirement, limit or preference that none of the plan's contract criteria covers.",
  accuracyFloor: 0.9,
  items: {
    uncovered_requirement: yesNo(
      'Does `request` state a requirement, limit or preference that none of `criteria` covers?',
      { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence },
      {
        true: 'Something the user asked for, limited or preferred appears in no entry of `criteria`',
        false: 'Everything the user asked for, limited or preferred appears in some entry of `criteria`, possibly in other words',
      },
    ),
  },
  fixtures: [
    {
      name: 'row limit left out',
      state: {
        request: 'Add CSV export to the reports page, limit it to 10,000 rows, and keep the existing PDF export working.',
        criteria: ['The reports page offers a CSV export', 'The existing PDF export still works'],
      },
      expect: { uncovered_requirement: 'yes' },
    },
    {
      name: 'every part covered',
      state: {
        request: 'Add CSV export to the reports page, limit it to 10,000 rows, and keep the existing PDF export working.',
        criteria: ['The reports page offers a CSV export', 'A CSV export contains at most 10,000 rows', 'The existing PDF export still works'],
      },
      expect: { uncovered_requirement: 'no' },
    },
    {
      name: 'dependency preference left out',
      state: {
        request: 'Write a Python script that renames photos by date taken. It must not overwrite existing files, and use only the standard library.',
        criteria: ['The script renames each photo by the date it was taken', 'The script never overwrites an existing file'],
      },
      expect: { uncovered_requirement: 'yes' },
    },
    {
      name: 'second feature left out',
      state: {
        request: "Make the login form accessible and add a 'remember me' checkbox.",
        criteria: ['The login form meets accessibility requirements for labels, focus order and contrast'],
      },
      expect: { uncovered_requirement: 'yes' },
    },
    {
      name: 'hands-off limit left out',
      state: {
        request: "Upgrade the app to React 18, and don't touch the webpack config.",
        criteria: ['The app builds and runs on React 18'],
      },
      expect: { uncovered_requirement: 'yes' },
    },
    {
      name: 'single requirement covered',
      state: { request: 'Fix the typo in the README heading.', criteria: ['The typo in the README heading is corrected'] },
      expect: { uncovered_requirement: 'no' },
    },
    {
      name: 'each test case covered',
      state: {
        request: 'Add unit tests for the date parser covering leap years and invalid input.',
        criteria: ['Unit tests for the date parser exist', 'The tests cover leap-year dates', 'The tests cover invalid input'],
      },
      expect: { uncovered_requirement: 'no' },
    },
    {
      name: 'limit covered in other words',
      state: {
        request: 'Speed up the search endpoint; it should respond in under 200ms for typical queries.',
        criteria: ['Typical queries to the search endpoint get a response in less than 200 milliseconds'],
      },
      expect: { uncovered_requirement: 'no' },
    },
  ],
});
