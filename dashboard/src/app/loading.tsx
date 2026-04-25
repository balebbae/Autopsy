import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="px-4 md:px-8 py-6 md:py-10 max-w-screen-2xl mx-auto space-y-6">
      <div>
        <Skeleton className="h-3 w-24 mb-2" />
        <Skeleton className="h-7 w-72" />
      </div>
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
        <Skeleton className="lg:col-span-2 h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  )
}
