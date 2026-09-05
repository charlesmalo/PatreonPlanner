import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { useNotifications, useSession } from './api/hooks';
import { Layout } from './components/Layout';
import { CreatorBoard } from './routes/CreatorBoard';
import { EntryDetail } from './routes/EntryDetail';
import { LandingPage } from './routes/LandingPage';
import { MyVotes } from './routes/MyVotes';
import { CarryOver } from './routes/CarryOver';
import { Premium } from './routes/Premium';
import { BoardSettings } from './routes/BoardSettings';
import { NotificationSettings } from './routes/NotificationSettings';
import { NotificationsPage } from './routes/NotificationsPage';
import { AcceptInvite } from './routes/AcceptInvite';
import { ReviewQueue } from './routes/ReviewQueue';
import { StaffPage } from './routes/StaffPage';
import { Support } from './routes/Support';
import { Tickets } from './routes/Tickets';

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
          <Route path="/c/:slug/my-votes" element={<MyVotes />} />
          <Route path="/c/:slug/notifications" element={<NotificationSettings />} />
          <Route path="/c/:slug/staff" element={<StaffPage />} />
          <Route path="/c/:slug/settings" element={<BoardSettings />} />
          <Route path="/c/:slug/tickets" element={<Tickets />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/carry-over" element={<CarryOver />} />
          <Route path="/premium" element={<Premium />} />
          <Route path="/support" element={<Support />} />
          <Route path="/invite" element={<AcceptInvite user={user} />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
