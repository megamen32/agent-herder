export type FleetSessionSnapshot<T> = {
 hostId:string;
 sessions:T[];
 complete:boolean;
 stale:boolean;
 hasPrevious:boolean;
};

/** Keep the last known list for the same machine when a refresh fails. */
export function failedSessionSnapshot<T>(
 previous:FleetSessionSnapshot<T>|null,
 hostId:string,
):FleetSessionSnapshot<T>{
 if(previous?.hostId===hostId)return {...previous,complete:false,stale:true,hasPrevious:true};
 return {hostId,sessions:[],complete:false,stale:true,hasPrevious:false};
}
