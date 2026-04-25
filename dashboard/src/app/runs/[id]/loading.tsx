import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="px-4 md:px-8 py-6 md:py-10 max-w-screen-2xl mx-auto space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-80" />
        <Skeleton className="h-3 w-60" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <aside className="lg:col-span-3 space-y-4 order-2 lg:order-1">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-44 w-full" />
        </aside>
        <div className="lg:col-span-6 space-y-4 order-1 lg:order-2">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
        <aside className="lg:col-span-3 order-3">
          <Skeleton className="h-96 w-full" />
        </aside>
      </div>
    </div>
  )
}
