import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StateDistribution, ThroughputChart } from '@/components/Charts';
import { EventFeed } from '@/components/EventFeed';
import { JobsTable } from '@/components/JobsTable';
import { StatCards } from '@/components/StatCards';
import { SubmitJobPanel } from '@/components/SubmitJobPanel';
import { WorkerList } from '@/components/WorkerList';

export function OverviewPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <StatCards />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <ThroughputChart />
        </div>
        <StateDistribution />
      </div>
      <div className="grid gap-4 xl:h-[580px] xl:grid-cols-3">
        <Card className="gap-3 overflow-hidden xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Recent jobs</CardTitle>
              <CardDescription>Newest first, across all states</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => onNavigate('jobs')}>
              View all
            </Button>
          </CardHeader>
          <JobsTable pageSize={8} compact showFilters={false} />
        </Card>
        <div className="h-[480px] min-h-0 xl:h-full">
          <EventFeed />
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <WorkerList compact />
        </div>
        <SubmitJobPanel />
      </div>
    </div>
  );
}
