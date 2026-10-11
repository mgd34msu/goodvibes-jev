/** Authored fixture outcomes for the synthetic pages in Google flow tests. */
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';

const labels: Readonly<Record<string, readonly string[]>> = {
  create: ['Create', 'CREATE'],
  'app name': ['  App   Name  ', 'App name'],
  'integrate calendar': ['Integrate calendar'],
  'Select the control matching the supplied structural constraints': ['Integrate calendar'],
  'Name the new Google app password': ['App name'],
  'Create the app password using the completed app-name form': ['Create'],
  'Publish this OAuth app to production': ['PUBLISH APP'],
  'Confirm publishing this OAuth app to production in the confirmation dialog': ['Confirm'],
  'Open the new OAuth client creation form': ['CREATE CLIENT'],
  'Open the application type selector for the new OAuth client': ['Application type'],
  'Choose Desktop app as the OAuth application type': ['Desktop app'],
  'Name the new Desktop OAuth client': ['Name'],
  'Submit the completed Desktop OAuth client creation form': ['Create'],
  'Find an existing OAuth client named exactly goodvibes agent': ['goodvibes agent'],
  'Open the calendar requested as My Calendar in calendar settings': ['My Calendar'],
  'Open the calendar requested as Work in calendar settings': ['Work Calendar'],
  'Open the primary calendar under Settings for my calendars': ['Work Calendar', 'My Calendar'],
  'Open the selected calendar integration settings': ['Integrate calendar'],
};
export function googleSetupFixturePort() {
  return fakePort((name, question, state) => {
    const input = state as unknown as { url?: string; elements?: { name: string }[]; context?: { purpose?: string }; candidates?: { id: string; content: { name: string } }[] };
    if (name === 'signIn') return noulAnswer(input.url === 'https://accounts.google.com/signin/v2/identifier'
      || input.elements?.some(e => e.name === 'Enter your password') ? 0.99 : 0.01);
    const offered = input.candidates ?? [];
    const admitted = labels[input.context?.purpose ?? ''] ?? [];
    const matched = offered.filter(e => admitted.includes(e.content.name));
    const chosen = matched.length === 1 ? matched[0]!.id : 'none';
    if (name === 'pick') return choiceAnswer(question, chosen, 0.99);
    return noulAnswer(name === `fits_${offered.findIndex(e => e.id === chosen)}` ? 0.99 : 0.01);
  });
}
