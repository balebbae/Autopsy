import Link from "next/link"
import { ArrowLeft, FileSearch } from "lucide-react"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/primitives/empty-state"

export default function NotFound() {
  return (
    <div className="px-4 md:px-8 py-12 max-w-3xl mx-auto">
      <EmptyState
        Icon={FileSearch}
        title="Run not found"
        description="That run id doesn't exist in the current AAG database. It may have been pruned, or you may have an outdated link."
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
