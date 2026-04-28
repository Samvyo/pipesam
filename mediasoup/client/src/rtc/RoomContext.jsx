import { createContext, useContext, useMemo } from "react";
import Room from "./Room";

const RoomContext = createContext(null);

export const RoomProvider = ({ children }) => {
  const room = useMemo(() => {
    return new Room(); // fresh instance
  }, []);

  return (
    <RoomContext.Provider value={room}>
      {children}
    </RoomContext.Provider>
  );
};

export const useRoom = () => useContext(RoomContext);