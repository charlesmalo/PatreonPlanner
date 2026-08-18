import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { useNotifications, useSession } from './api/hooks';
import { Layout } from './components/Layout';
import { CreatorBoard } from './routes/CreatorBoard';
import { EntryDetail } from './routes/EntryDetail';
import { LandingPage } from './routes/LandingPage';
import { NotificationsPage } from './routes/NotificationsPage';
import { AcceptInvite } from './routes/AcceptInvite';
import { ReviewQueue } from './routes/ReviewQueue';
import { StaffPage } from './routes/StaffPage';

export default function App() {
  const { user, loading, signOut } = useSession();
  const notifications = useNotifications(user !== null);

  return (
    <BrowserRouter>
      <Layout
        user={user}
        loadingSession={loading}
        onSignOut={signOut}
        notifications={notifications}
      >
        <Routes>
          <Route path="/" element={<LandingPage signedIn={user !== null} />} />
          <Route path="/c/:slug" element={<CreatorBoard />} />
          <Route path="/c/:slug/e/:id" element={<EntryDetail />} />
          <Route path="/c/:slug/review" element={<ReviewQueue />} />
          <Route path="/c/:slug/staff" element={<StaffPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/invite" element={<AcceptInvite user={user} />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
