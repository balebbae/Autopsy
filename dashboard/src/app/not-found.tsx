import Link from "next/link"
import { ArrowLeft, Compass } from "lucide-react"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/primitives/empty-state"

export default function NotFound() {
  return (
    <div className="px-4 md:px-8 py-12 max-w-3xl mx-auto">
      <EmptyState
        Icon={Compass}
        title="Page not found"
        description="That route doesn't exist in the dashboard. Try the runs list, the failure graph, or the preflight playground."
        action={
          <Button asChild variant="outline">
            <Link href="/">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to runs
            </Link>
          </Button>
        }
      />
    </div>
  )
}
