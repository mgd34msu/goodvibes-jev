import { bootstrap } from './bootstrap';
import './styles.css';

// The entry guard runs first: on a plain-http non-local origin the SDK transport would
// throw at module load and leave a silent blank page, so bootstrap() checks the origin and
// renders an honest "needs HTTPS" message instead of importing the app graph there. On a
// secure origin it dynamically imports mount-app and boots the real app.
const root = document.getElementById('root');
if (root) void bootstrap(root);
